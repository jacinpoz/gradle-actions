import path from 'path'
import fs from 'fs'
import * as core from '@actions/core'
import * as glob from '@actions/glob'

import {CacheEntryListener, CacheListener, measure} from './cache-reporting'
import {
    cacheDebug,
    deleteAll,
    entryConcurrency,
    hashFileNames,
    hashStrings,
    isCacheDebuggingEnabled,
    mapConcurrently,
    restoreCache,
    saveCache,
    tryDelete
} from './cache-utils'

import {BuildResult, loadBuildResults} from '../build-results'
import {CacheConfig, ACTION_METADATA_DIR} from '../configuration'
import {getCacheKeyBase} from './cache-key'
import {matchedEntryParents, resolveEntryPattern, withExplicitPaths} from './cache-glob'
import {versionIsAtLeast} from '../execution/gradle'

const SKIP_RESTORE_VAR = 'GRADLE_BUILD_ACTION_SKIP_RESTORE'
const CACHE_PROTOCOL_VERSION = 'v1'

const LAYERS_VAR = 'GRADLE_ACTIONS_CACHE_LAYERS'

/**
 * How many cache entries one extracted entry's content may be spread across: a base and three deltas.
 *
 * Every layer costs a round trip to restore, so the chain is collapsed back into a single base once it is
 * full. That collapse is the one run in four, for an entry that changes every run, which still pays to
 * upload the whole entry -- a chain of two would make it every other run and halve the saving, while a much
 * longer chain would put a run of small sequential downloads in front of every build.
 */
const MAX_LAYERS = 4

/**
 * The largest delta, as a fraction of the whole entry, still worth saving as a layer rather than replacing
 * the base. Beyond this the layer is nearly as large as a fresh base, which would then be carried by every
 * restore for no saving.
 */
const MAX_DELTA_FRACTION = 0.25

/**
 * How much of a restored entry may disappear before the chain is collapsed into a fresh base.
 *
 * A layer can only add paths, so a chain restores content that cache cleanup has since pruned. That wastes
 * a little space but is not incorrect, and collapsing the chain every time cleanup removed a single file
 * would defeat layering entirely on any job that runs cleanup.
 */
const MAX_PRUNE_FRACTION = 0.1

/**
 * How far before the restore to place the cutoff for deciding what the build created.
 *
 * A path is new when it was modified after the entry was restored, but both sides of that comparison are
 * approximate: a filesystem may hold modification times to a coarser resolution than the clock this is
 * compared against, and content written moments after the restore would then look as though it had been
 * restored -- and go unsaved. Moving the cutoff back a second errs the other way: a little restored content
 * is re-saved in the layer, which costs a few paths and loses nothing.
 */
const MODIFIED_SINCE_MARGIN_MS = 1000

/** Whether incremental layers are enabled. Set the variable to 'false' to always save a full entry. */
function layeringEnabled(): boolean {
    return process.env[LAYERS_VAR] !== 'false'
}

/**
 * Represents the result of attempting to load or store an extracted cache entry.
 * An undefined cacheKey indicates that the operation did not succeed.
 * The collected results are then used to populate the `cache-metadata.json` file for later use.
 */
class ExtractedCacheEntry {
    artifactType: string
    pattern: string
    /** Identifies the content this entry holds, whichever way it is delivered. */
    cacheKey: string | undefined
    /**
     * The cache entries that together hold this content, base first. Absent in metadata written before
     * layering existed, in which case the content is held entirely by `cacheKey`.
     */
    layers: string[] | undefined
    /** How many paths this content held, so that a later run can tell whether the content was pruned. */
    pathCount: number | undefined
    /** The bundle this entry is a shard of, if it is one. */
    bundle: string | undefined
    /**
     * The archive size of the last full save of this entry, carried across saves that only added a layer.
     * Summed over a bundle's shards, it is how the next run decides how many shards to use.
     */
    baseSizeBytes: number | undefined

    constructor(
        artifactType: string,
        pattern: string,
        cacheKey: string | undefined,
        layers?: string[],
        pathCount?: number,
        bundle?: string,
        baseSizeBytes?: number
    ) {
        this.artifactType = artifactType
        this.pattern = pattern
        this.cacheKey = cacheKey
        this.layers = layers
        this.pathCount = pathCount
        this.bundle = bundle
        this.baseSizeBytes = baseSizeBytes
    }
}

/**
 * The cache entries that hold an entry's content, base first.
 *
 * Metadata written before layering existed records only `cacheKey`, which held the whole content, so it
 * reads as a single-layer chain and needs no protocol change.
 */
export function layersOf(entry: {cacheKey?: string; layers?: string[]}): string[] {
    if (entry.layers && entry.layers.length > 0) {
        return entry.layers
    }
    return entry.cacheKey ? [entry.cacheKey] : []
}

/**
 * How large a bundle's archives came to, summed over the shards it was split into last time, or undefined
 * when no run has reported a size for it.
 */
export function bundleSizeBytes(entries: ExtractedCacheEntry[], artifactType: string): number | undefined {
    const sizes = entries
        .filter(entry => entry.bundle === artifactType || entry.artifactType === artifactType)
        .map(entry => entry.baseSizeBytes)
    // A size missing from any shard would understate the whole, which would leave a bundle that needs
    // splitting under-sharded. Better to fall back to the path count than to act on a partial total.
    if (sizes.length === 0 || sizes.some(size => size === undefined)) {
        return undefined
    }
    return sizes.reduce((total: number, size) => total + (size ?? 0), 0)
}

/** Names a layer in the caching report. The first layer keeps the entry's own name. */
export function layerEntryName(pattern: string, index: number): string {
    return index === 0 ? pattern : `${pattern} [layer ${index + 1}]`
}

/**
 * Representation of all of the extracted cache entries for this Gradle User Home.
 * This object is persisted to JSON file in the Gradle User Home directory for storing,
 * and subsequently used to restore the Gradle User Home.
 */
class ExtractedCacheEntryMetadata {
    entries: ExtractedCacheEntry[] = []
    /**
     * When the entries were restored into this Gradle User Home, if they were.
     *
     * Anything the build then created carries a later modification time, because `tar` restores the
     * modification time recorded in the archive. That is what distinguishes new content from restored
     * content when saving, without having to persist the full list of restored paths.
     */
    restoredAt: number | undefined
}

/**
 * The specification for a type of extracted cache entry.
 */
export class ExtractedCacheEntryDefinition {
    artifactType: string
    pattern: string
    bundle: boolean
    uniqueFileNames = true
    shardable = false
    notCacheableReason: string | undefined

    constructor(artifactType: string, pattern: string, bundle: boolean) {
        this.artifactType = artifactType
        this.pattern = pattern
        this.bundle = bundle
    }

    /**
     * Allow this bundle to be split across several cache entries, on the trailing hex character of the
     * final path segment. How many is decided per run by `shardCountFor`, from how large the bundle's
     * archives came to last time: only enough to keep one entry from growing unwieldy.
     *
     * Gradle names these directories after a content hash (an artifact sha1 under `modules-2`, a transform
     * or accessors hash elsewhere), so the shard a directory belongs to is fixed by its own content and
     * never moves when unrelated entries change. A single new or updated dependency therefore invalidates
     * one shard rather than the whole bundle.
     *
     * Any directory whose name does not end in a hex character matches no shard and is left in the main
     * Gradle User Home entry, which is where it would have lived had this bundle never been extracted.
     */
    withShards(): ExtractedCacheEntryDefinition {
        this.shardable = true
        return this
    }

    /**
     * Indicate that the file names matching the cache entry pattern are NOT sufficient to uniquely identify the contents.
     * If the file names are sufficient, then we use a hash of the file names to identify the entry.
     * With non-unique-file-names, we hash the file contents to identify the cache entry.
     */
    withNonUniqueFileNames(): ExtractedCacheEntryDefinition {
        this.uniqueFileNames = false
        return this
    }

    /**
     * Specify that the cache entry, should not be saved for some reason, even though the contents exist.
     * This is used to prevent configuration-cache entries being cached when they were generated by Gradle < 8.6,
     */
    notCacheableBecause(reason: string): ExtractedCacheEntryDefinition {
        this.notCacheableReason = reason
        return this
    }
}

const HEX_DIGITS = '0123456789abcdef'

/**
 * How many shards a bundle may be split into. Each has to be a whole number of hex suffixes, so that a
 * path's shard follows from its name, which restricts the choice to the divisors of 16.
 */
const SHARD_COUNTS = [1, 2, 4, 8, 16]

/**
 * How large a shard's archive should be allowed to get.
 *
 * Sharding exists to bound this. It used to be fixed at 16 shards, which cost what it cost regardless of
 * how much was in the bundle: measured against a local cache service at 50 ms round-trip latency, sixteen
 * shards restored in 3176-4092 ms against 2199-2547 ms for one entry, because every shard is its own
 * lookup and download. It buys nothing in bytes -- across six rounds the same content took 233 MB sharded
 * and 224 MB not -- so the only reason to split a bundle is to keep any one entry from growing unwieldy.
 */
const MAX_SHARD_BYTES = 1024 * 1024 * 1024

/**
 * How many paths a shard should hold on average, when nothing is yet known about how large a bundle is.
 */
const MIN_PATHS_PER_SHARD = 32

/** Forces a shard count, for measuring the effect of one. Not something a workflow should set. */
function shardCountOverride(): number | undefined {
    const override = Number(process.env['GRADLE_ACTIONS_CACHE_SHARDS'])
    return SHARD_COUNTS.includes(override) ? override : undefined
}

/**
 * How many shards to split a bundle into, given the size its archives came to last time and how many paths
 * it matches now.
 *
 * The size is what decides it: enough shards to keep each one under `MAX_SHARD_BYTES`, and no more. Until a
 * run has reported a size there is nothing to go on, so the first run keeps what this action did before,
 * which is to shard a bundle with enough paths in it and leave a small one whole.
 */
export function shardCountFor(bundleBytes: number | undefined, matchedPathCount: number): number {
    const override = shardCountOverride()
    if (override !== undefined) {
        return override
    }
    if (bundleBytes === undefined) {
        return matchedPathCount >= 16 * MIN_PATHS_PER_SHARD ? 16 : 1
    }
    return SHARD_COUNTS.find(count => bundleBytes / count <= MAX_SHARD_BYTES) ?? 16
}

/**
 * The hex suffixes belonging to each shard, in order. Contiguous, so that a path's shard is its trailing
 * character divided by the size of a shard.
 */
export function shardSuffixGroups(count: number): string[][] {
    const size = HEX_DIGITS.length / count
    return Array.from({length: count}, (_, index) => HEX_DIGITS.slice(index * size, (index + 1) * size).split(''))
}

/**
 * Which shard a matched path belongs to, or undefined if it belongs to none.
 *
 * Membership follows from the directory name alone, so it is stable across runs at a given shard count: a
 * directory only moves when its content hash changes, which makes it a different directory. Trailing
 * characters are used rather than leading ones because Gradle renders the `modules-2` sha1 numerically and
 * drops leading zeros: roughly 6% of names are shorter than 40 characters, none starts with '0', and those
 * hashes pile up on the remaining shards. Trailing characters measure out evenly -- 1.09x max/mean over a
 * real cache of 7,755 artifacts, against 2.32x by leading character.
 */
export function shardIndexForPath(filePath: string, count: number): number | undefined {
    const last = path.basename(filePath).toLowerCase().slice(-1)
    const value = HEX_DIGITS.indexOf(last)
    return value < 0 ? undefined : Math.floor(value / (HEX_DIGITS.length / count))
}

/**
 * The pattern matching one shard: every line of the bundle's pattern, once per suffix the shard covers,
 * with the last wildcard of the line constrained to names ending in it.
 *
 * The pattern is rewritten rather than replaced by the resolved file list because `@actions/cache` derives
 * its cache version from a hash of the paths it is given: the value passed when saving has to match the
 * value passed when restoring, and it is persisted to the cache metadata file in between. Patterns keep
 * that metadata small, which matters when a bundle covers tens of thousands of directories.
 *
 *   caches/modules-*\/files-*\/*\/*\/*\/*  ->  caches/modules-*\/files-*\/*\/*\/*\/*a
 *   caches/*\/transforms/*\/                ->  caches/*\/transforms/*a/
 */
export function shardPatternForSuffixes(pattern: string, suffixes: string[]): string {
    return pattern
        .split('\n')
        .flatMap(line => suffixes.map(suffix => line.replace(/\*(?=[^*]*$)/, `*${suffix}`)))
        .join('\n')
}

/** Names the shard entry for a bundle, so that a change of shard count is a change of identity. */
export function shardArtifactType(artifactType: string, count: number, index: number): string {
    return `${artifactType}-${count}-${index}`
}

/** Restores or saves one cache entry. Deferred so that the fan-out can be bounded. */
type EntryAction = () => Promise<ExtractedCacheEntry>

/** The outcome of restoring an extractor's entries, before it is written to the metadata file. */
export interface RestoredEntries {
    entries: ExtractedCacheEntry[]
    restoredAt: number
}

/** What to save as one extracted cache entry. */
interface EntrySaveRequest {
    matchingFiles: string[]
    artifactType: string
    /** The bundle this entry is a shard of, if it is one. */
    bundle?: string
    pattern: string
    /** Whether the matched file names identify the content, so that the key can be hashed from them. */
    uniqueFileNames: boolean
    /** Whether this entry's content can be delivered as a base plus incremental layers. */
    layerable: boolean
}

/**
 * Whether a chain of layers can be extended rather than replaced by a fresh base.
 *
 * Nothing about the delta is considered here: this is only about the state of the chain and whether the
 * content it restored is still there.
 */
export function canExtendLayers(
    matchedPathCount: number,
    restoredPathCount: number | undefined,
    layerCount: number
): boolean {
    // Nothing was restored for this entry, so there is no base to layer onto.
    if (restoredPathCount === undefined || layerCount === 0) {
        return false
    }
    // The chain is as long as it may get: collapse it back into a single base.
    if (layerCount >= MAX_LAYERS) {
        return false
    }
    // Content has been pruned, most likely by cache cleanup. A layer can only add paths, so the base would
    // keep restoring what was pruned.
    return matchedPathCount >= restoredPathCount * (1 - MAX_PRUNE_FRACTION)
}

/**
 * Whether a delta of this size is worth saving as a layer.
 *
 * An empty delta means paths were removed without enough of them going to look like a prune, and a layer
 * cannot express a removal. A delta approaching the size of the whole entry saves little and would then be
 * carried by every restore.
 */
export function isDeltaWorthLayering(deltaPathCount: number, matchedPathCount: number): boolean {
    return deltaPathCount > 0 && deltaPathCount <= matchedPathCount * MAX_DELTA_FRACTION
}

/**
 * Whether a path was modified after the given time. A path that has since disappeared counts as modified,
 * so that a race against a concurrently changing cache errs towards saving it rather than losing it.
 */
export function modifiedAfter(file: string, time: number): boolean {
    try {
        return fs.statSync(file).mtimeMs > time
    } catch {
        return true
    }
}

/**
 * Caches and restores the entire Gradle User Home directory, extracting entries containing common artifacts
 * for more efficient storage.
 */
abstract class AbstractEntryExtractor {
    protected readonly cacheConfig: CacheConfig
    protected readonly gradleUserHome: string
    private extractorName: string

    constructor(gradleUserHome: string, extractorName: string, cacheConfig: CacheConfig) {
        this.gradleUserHome = gradleUserHome
        this.extractorName = extractorName
        this.cacheConfig = cacheConfig
    }

    /**
     * Restores any artifacts that were cached separately, based on the information in the `cache-metadata.json` file.
     * Each extracted cache entry is restored in parallel, except when debugging is enabled.
     */
    async restore(listener: CacheListener): Promise<void> {
        this.persistRestored(await this.restoreEntries(listener))
    }

    /**
     * Restores the entries named by the metadata, and reports the outcome rather than writing it.
     *
     * Split from `restore` because the Gradle User Home entry carries its own copy of the metadata files:
     * when it is restored at the same time as these entries, extracting it would undo a metadata file
     * written here, so the caller writes it once that archive has finished. See `persistRestored`.
     */
    async restoreEntries(listener: CacheListener): Promise<RestoredEntries> {
        const previouslyExtractedCacheEntries = this.loadMetadata().entries

        // Created up front because several entries extract into the same tree at once -- and, when the
        // entry index was restored, the Gradle User Home entry does too -- so no two 'tar' processes are
        // left racing to create a directory they both need.
        //
        // An entry's pattern may have lines that match nothing in this Gradle User Home -- 'transforms'
        // names both 'caches/transforms-4' and 'caches/<version>/transforms', and a given Gradle version
        // uses one of them -- so the ones that stay empty are removed again below rather than left behind
        // as directories the action invented.
        const createdDirectories: string[] = []
        for (const cacheEntry of previouslyExtractedCacheEntries) {
            for (const parent of matchedEntryParents(cacheEntry.pattern)) {
                if (fs.mkdirSync(parent, {recursive: true}) !== undefined) {
                    createdDirectories.push(parent)
                }
            }
        }

        const restoreActions: EntryAction[] = []

        for (const cacheEntry of previouslyExtractedCacheEntries) {
            const artifactType = cacheEntry.artifactType
            const entryListener = listener.entry(cacheEntry.pattern)

            // Handle case where the extracted-cache-entry definitions have been changed
            const skipRestore = process.env[SKIP_RESTORE_VAR] || ''
            if (skipRestore.includes(artifactType)) {
                core.info(`Not restoring extracted cache entry for ${artifactType}`)
                entryListener.markRequested('SKIP_RESTORE')
            } else {
                restoreActions.push(async () => this.restoreExtractedCacheEntry(cacheEntry, listener))
            }
        }

        // The time is recorded before the restores rather than after: a path whose modification time is
        // later than this was written after its own entry finished restoring, so it is new either way, and
        // taking the earlier of the two times can only classify a path as new that in fact is.
        const restoredAt = Date.now()
        const entries = await this.runEntryActions(restoreActions)

        for (const directory of createdDirectories) {
            try {
                fs.rmdirSync(directory)
                cacheDebug(`Removed ${directory}, which no restored entry wrote to`)
            } catch {
                // Not empty: an entry restored into it, which is what it was created for.
            }
        }

        return {entries, restoredAt}
    }

    /** Writes the outcome of `restoreEntries` to the metadata file. */
    persistRestored(restored: RestoredEntries): void {
        this.saveMetadataForCacheResults(restored.entries, restored.restoredAt)
    }

    /**
     * Restores every layer of one entry, in order, so that a later layer's copy of a path wins.
     *
     * A chain is only as good as its weakest link: if any layer is missing then the content is incomplete,
     * so the entry is reported as not restored and the next save replaces it with a fresh base.
     */
    private async restoreExtractedCacheEntry(
        cacheEntry: ExtractedCacheEntry,
        listener: CacheListener
    ): Promise<ExtractedCacheEntry> {
        const {artifactType, pattern} = cacheEntry
        const layers = layersOf(cacheEntry)
        const cachePaths = pattern.split('\n')

        for (const [index, layerKey] of layers.entries()) {
            const entryListener = listener.entry(layerEntryName(pattern, index))
            const restoredEntry = await restoreCache(cachePaths, layerKey, [], entryListener)
            if (!restoredEntry) {
                core.info(`Did not restore ${artifactType} with key ${layerKey} to ${pattern}`)
                return new ExtractedCacheEntry(artifactType, pattern, undefined)
            }
        }

        return new ExtractedCacheEntry(
            artifactType,
            pattern,
            cacheEntry.cacheKey,
            layers,
            cacheEntry.pathCount,
            cacheEntry.bundle,
            cacheEntry.baseSizeBytes
        )
    }

    /**
     * Saves any artifacts that are configured to be cached separately, based on the extracted cache entry definitions.
     * Each entry is extracted and saved in parallel, except when debugging is enabled.
     */
    async extract(listener: CacheListener): Promise<void> {
        // Load the cache entry definitions (from config) and the previously restored entries (from persisted metadata file)
        const cacheEntryDefinitions = this.getExtractedCacheEntryDefinitions()
        cacheDebug(
            `Extracting cache entries for ${this.extractorName}: ${JSON.stringify(cacheEntryDefinitions, null, 2)}`
        )

        const previousMetadata = this.loadMetadata()
        const previouslyRestoredEntries = previousMetadata.entries
        const restoredAt = previousMetadata.restoredAt
        const saveActions: EntryAction[] = []

        // For each cache entry definition, determine if it has already been restored, and if not, extract it
        for (const cacheEntryDefinition of cacheEntryDefinitions) {
            const artifactType = cacheEntryDefinition.artifactType
            const pattern = cacheEntryDefinition.pattern

            if (cacheEntryDefinition.notCacheableReason) {
                listener.entry(pattern).markNotSaved(cacheEntryDefinition.notCacheableReason)
                continue
            }

            // Find all matching files for this cache entry definition.
            // Resolved by reading only the directories the pattern names: see cache-glob.ts for why
            // '@actions/glob' is an order of magnitude slower for these particular patterns.
            const {result: matchingFiles, milliseconds: resolveTime} = measure(() => resolveEntryPattern(pattern))
            listener.addPhaseTime('resolve entry patterns', resolveTime)

            if (matchingFiles.length === 0) {
                cacheDebug(`No files found to cache for ${artifactType}`)
                continue
            }

            const shardCount = cacheEntryDefinition.shardable
                ? shardCountFor(bundleSizeBytes(previouslyRestoredEntries, artifactType), matchingFiles.length)
                : 1

            if (cacheEntryDefinition.bundle && shardCount > 1) {
                // Partitioned here, from the single resolve already performed above, rather than by
                // resolving once per shard.
                const groups = shardSuffixGroups(shardCount)
                const shards = new Map<number, string[]>()
                let unsharded = 0

                for (const matchingFile of matchingFiles) {
                    const index = shardIndexForPath(matchingFile, shardCount)
                    if (index === undefined) {
                        unsharded++
                        continue
                    }
                    const shard = shards.get(index)
                    if (shard) {
                        shard.push(matchingFile)
                    } else {
                        shards.set(index, [matchingFile])
                    }
                }

                if (unsharded > 0) {
                    // Left in the main Gradle User Home entry rather than dropped.
                    cacheDebug(
                        `${unsharded} of ${matchingFiles.length} ${artifactType} paths do not end in hex and match no shard`
                    )
                }

                cacheDebug(`Sharding ${artifactType} into ${shards.size} of ${shardCount} entries`)

                for (const [index, group] of groups.entries()) {
                    const shardFiles = shards.get(index)
                    if (!shardFiles) {
                        continue
                    }
                    saveActions.push(async () =>
                        this.saveExtractedCacheEntry(
                            {
                                matchingFiles: shardFiles,
                                artifactType: shardArtifactType(artifactType, shardCount, index),
                                bundle: artifactType,
                                pattern: shardPatternForSuffixes(pattern, group),
                                uniqueFileNames: cacheEntryDefinition.uniqueFileNames,
                                layerable: cacheEntryDefinition.uniqueFileNames
                            },
                            previouslyRestoredEntries,
                            restoredAt,
                            listener
                        )
                    )
                }
            } else if (cacheEntryDefinition.bundle) {
                // For an extracted "bundle", use the defined pattern and cache all matching files in a single entry.
                saveActions.push(async () =>
                    this.saveExtractedCacheEntry(
                        {
                            matchingFiles,
                            artifactType,
                            pattern,
                            uniqueFileNames: cacheEntryDefinition.uniqueFileNames,
                            layerable: cacheEntryDefinition.uniqueFileNames
                        },
                        previouslyRestoredEntries,
                        restoredAt,
                        listener
                    )
                )
            } else {
                // Otherwise cache each matching file in a separate entry, using the complete file path as the cache pattern.
                for (const cacheFile of matchingFiles) {
                    saveActions.push(async () =>
                        this.saveExtractedCacheEntry(
                            {
                                matchingFiles: [cacheFile],
                                artifactType,
                                pattern: cacheFile,
                                uniqueFileNames: cacheEntryDefinition.uniqueFileNames,
                                // A single-path entry has nothing to deliver incrementally.
                                layerable: false
                            },
                            previouslyRestoredEntries,
                            restoredAt,
                            listener
                        )
                    )
                }
            }
        }

        this.saveMetadataForCacheResults(await this.runEntryActions(saveActions))
    }

    private async saveExtractedCacheEntry(
        request: EntrySaveRequest,
        previouslyRestoredEntries: ExtractedCacheEntry[],
        restoredAt: number | undefined,
        listener: CacheListener
    ): Promise<ExtractedCacheEntry> {
        const {matchingFiles, artifactType, bundle, pattern, uniqueFileNames} = request
        const entryListener = listener.entry(pattern)

        const keyStartTime = Date.now()
        const cacheKey = uniqueFileNames
            ? this.createCacheKeyFromFileNames(artifactType, matchingFiles)
            : await this.createCacheKeyFromFileContents(artifactType, pattern)
        entryListener.markKeyTime(Date.now() - keyStartTime)

        const previous = previouslyRestoredEntries.find(x => x.artifactType === artifactType && x.pattern === pattern)
        const previousLayers = previous ? layersOf(previous) : []

        let layers: string[]
        // Only a full save measures the whole entry; a layer saves a fraction of it, so the size recorded
        // for the base is carried forward until the next one replaces it.
        let baseSizeBytes = previous?.baseSizeBytes
        if (previous?.cacheKey === cacheKey) {
            cacheDebug(`No change to previously restored ${artifactType}. Not saving.`)
            entryListener.markNotSaved('contents unchanged')
            layers = previousLayers
        } else {
            const delta = this.deltaToSave(request, previous, previousLayers, restoredAt, listener)

            if (delta) {
                // Only the paths the build added are stored. The pattern is unchanged, so the layer is
                // restorable by its key alone, and the paths are supplied to '@actions/cache' directly.
                const layerKey = this.layerKey(artifactType, previousLayers, delta)
                const layerNumber = previousLayers.length + 1
                const layerListener = listener.entry(layerEntryName(pattern, previousLayers.length))
                core.info(
                    `Saving ${delta.length} of ${matchingFiles.length} ${artifactType} paths as layer ${layerNumber}`
                )
                entryListener.markNotSaved(`${delta.length} new paths saved as layer ${layerNumber}`)
                await this.saveEntry(pattern, delta, layerKey, layerListener)
                layers = [...previousLayers, layerKey]
            } else {
                baseSizeBytes = await this.saveEntry(pattern, matchingFiles, cacheKey, entryListener)
                layers = [cacheKey]
            }
        }

        // Deleted from the Gradle User Home so that the content is not stored a second time inside the
        // main cache entry. Awaited: the previous fire-and-forget call left a rejected promise unhandled
        // when a path could not be deleted, which terminates the post-action step.
        const deleteStartTime = Date.now()
        await deleteAll(matchingFiles)
        entryListener.markDeleteTime(Date.now() - deleteStartTime)

        return new ExtractedCacheEntry(
            artifactType,
            pattern,
            cacheKey,
            layers,
            matchingFiles.length,
            bundle,
            baseSizeBytes
        )
    }

    /**
     * Saves the given paths under the given key, as the content matched by the given pattern.
     *
     * The paths are handed to '@actions/cache' directly: it would otherwise resolve the pattern a second
     * time, which for a sharded bundle repeats the same directory reads once per shard, and it lets a layer
     * store a subset of what the pattern matches. The pattern is still what is passed as the entry's paths,
     * because that is what the cache version is derived from, and it has to agree between save and restore.
     */
    private async saveEntry(
        pattern: string,
        files: string[],
        cacheKey: string,
        entryListener: CacheEntryListener
    ): Promise<number | undefined> {
        const cachePaths = pattern.split('\n')
        return withExplicitPaths(cachePaths, files, async () => saveCache(cachePaths, cacheKey, entryListener))
    }

    /**
     * The paths worth saving as an incremental layer on top of what was restored, or undefined when the
     * whole entry should be saved afresh.
     *
     * A path is new when it was modified after the entry was restored: `tar` restores the modification time
     * recorded in the archive, so restored content keeps the time it had when it was saved, and only the
     * build writes anything later than that. Nothing about the restored content has to be persisted for
     * this, which matters when an entry covers a hundred thousand paths.
     */
    private deltaToSave(
        request: EntrySaveRequest,
        previous: ExtractedCacheEntry | undefined,
        previousLayers: string[],
        restoredAt: number | undefined,
        listener: CacheListener
    ): string[] | undefined {
        const {matchingFiles, artifactType, layerable} = request

        if (!layerable || !layeringEnabled() || restoredAt === undefined) {
            return undefined
        }
        if (!canExtendLayers(matchingFiles.length, previous?.pathCount, previousLayers.length)) {
            cacheDebug(
                `Rewriting ${artifactType} as a new base: ${previousLayers.length} layers, ` +
                    `${previous?.pathCount} paths restored, ${matchingFiles.length} now present`
            )
            return undefined
        }

        const cutoff = restoredAt - MODIFIED_SINCE_MARGIN_MS
        const {result: delta, milliseconds} = measure(() => matchingFiles.filter(file => modifiedAfter(file, cutoff)))
        listener.addPhaseTime('find new paths', milliseconds)

        if (!isDeltaWorthLayering(delta.length, matchingFiles.length)) {
            cacheDebug(
                `Rewriting ${artifactType} as a new base: ${delta.length} of ${matchingFiles.length} paths are new`
            )
            return undefined
        }
        return delta
    }

    /**
     * The key for a layer, derived from the chain it sits on top of as well as its own content.
     *
     * The chain has to be part of it: two jobs can reach the same content from different bases, and a key
     * that named only the resulting content would have them both claim it for different deltas. Cache
     * entries are immutable, so the loser's metadata would then name a layer holding content that does not
     * complete its own base.
     */
    private layerKey(artifactType: string, previousLayers: string[], delta: string[]): string {
        const deltaNames = delta.map(x => this.relativeToGradleUserHome(x))
        const key = hashStrings([...previousLayers, hashFileNames(deltaNames)])
        return `${getCacheKeyBase(artifactType, CACHE_PROTOCOL_VERSION)}-${key}`
    }

    protected createCacheKeyFromFileNames(artifactType: string, files: string[]): string {
        const relativeFiles = files.map(x => this.relativeToGradleUserHome(x))
        const key = hashFileNames(relativeFiles)

        cacheDebug(`Generating cache key for ${artifactType} from file names: ${relativeFiles}`)

        return `${getCacheKeyBase(artifactType, CACHE_PROTOCOL_VERSION)}-${key}`
    }

    /**
     * Names a matched file relative to the Gradle User Home.
     *
     * Cache entry patterns are anchored at the Gradle User Home, so a match is almost always a plain
     * prefix of the path and the relative name is a slice. path.relative re-resolves and re-normalizes
     * both paths, which cost 115 ms across the 177k files matched by the transforms entry against 9 ms
     * for the slice. Anything not under the home still goes through path.relative.
     */
    private relativeToGradleUserHome(file: string): string {
        const prefix = this.gradleUserHome.endsWith(path.sep) ? this.gradleUserHome : this.gradleUserHome + path.sep
        return file.startsWith(prefix) ? file.slice(prefix.length) : path.relative(this.gradleUserHome, file)
    }

    protected async createCacheKeyFromFileContents(artifactType: string, pattern: string): Promise<string> {
        const key = await glob.hashFiles(pattern)

        cacheDebug(`Generating cache key for ${artifactType} from files matching: ${pattern}`)

        return `${getCacheKeyBase(artifactType, CACHE_PROTOCOL_VERSION)}-${key}`
    }

    /**
     * Restores or saves cache entries with a bounded number in flight, one entry per action.
     *
     * Each entry runs a `tar` piped through `zstdmt -T0` and, when restoring, its own set of concurrent
     * range requests. A large Gradle User Home defines around fifty entries once the big bundles are
     * sharded, so starting them all at once puts fifty multi-threaded compressors on a four-core runner
     * for no gain: the transfers are already concurrent within each entry.
     *
     * Runs one at a time when cache debugging is enabled, so that the log stays readable -- which is what
     * the eagerly-awaited promises this replaced were for.
     */
    private async runEntryActions(actions: EntryAction[]): Promise<ExtractedCacheEntry[]> {
        const concurrency = isCacheDebuggingEnabled() ? 1 : entryConcurrency()
        cacheDebug(`Processing ${actions.length} cache entries, ${concurrency} at a time`)
        return mapConcurrently(actions, concurrency, async action => action())
    }

    /**
     * Load information about the extracted cache entries previously restored/saved. This is loaded from the 'cache-metadata.json' file.
     */
    protected loadMetadata(): ExtractedCacheEntryMetadata {
        const cacheMetadataFile = this.getCacheMetadataFile()
        if (!fs.existsSync(cacheMetadataFile)) {
            return new ExtractedCacheEntryMetadata()
        }

        const filedata = fs.readFileSync(cacheMetadataFile, 'utf-8')
        cacheDebug(`Loaded cache metadata for ${this.extractorName}: ${filedata}`)
        return JSON.parse(filedata) as ExtractedCacheEntryMetadata
    }

    protected loadExtractedCacheEntries(): ExtractedCacheEntry[] {
        return this.loadMetadata().entries
    }

    /**
     * Saves information about the extracted cache entries into the 'cache-metadata.json' file.
     *
     * `restoredAt` is recorded only when restoring: it is read back when saving, to tell content the build
     * created from content that was restored, and must not survive into the file the next run reads.
     */
    protected saveMetadataForCacheResults(results: ExtractedCacheEntry[], restoredAt?: number): void {
        const extractedCacheEntryMetadata = new ExtractedCacheEntryMetadata()
        extractedCacheEntryMetadata.entries = results.filter(x => x.cacheKey !== undefined)
        extractedCacheEntryMetadata.restoredAt = restoredAt

        const filedata = JSON.stringify(extractedCacheEntryMetadata)
        cacheDebug(`Saving cache metadata for ${this.extractorName}: ${filedata}`)

        fs.writeFileSync(this.getCacheMetadataFile(), filedata, 'utf-8')
    }

    private getCacheMetadataFile(): string {
        const actionMetadataDirectory = path.resolve(this.gradleUserHome, ACTION_METADATA_DIR)
        fs.mkdirSync(actionMetadataDirectory, {recursive: true})

        return path.resolve(actionMetadataDirectory, `${this.extractorName}-entry-metadata.json`)
    }

    protected abstract getExtractedCacheEntryDefinitions(): ExtractedCacheEntryDefinition[]
}

export class GradleHomeEntryExtractor extends AbstractEntryExtractor {
    constructor(gradleUserHome: string, cacheConfig: CacheConfig) {
        super(gradleUserHome, 'gradle-home', cacheConfig)
    }

    async extract(listener: CacheListener): Promise<void> {
        await this.deleteWrapperZips()
        return super.extract(listener)
    }

    /**
     * Delete any downloaded wrapper zip files that are not needed after extraction.
     * These files are cleaned up by Gradle >= 7.5, but for older versions we remove them manually.
     */
    private async deleteWrapperZips(): Promise<void> {
        const wrapperZips = path.resolve(this.gradleUserHome, 'wrapper/dists/*/*/*.zip')

        for (const wrapperZip of resolveEntryPattern(wrapperZips)) {
            cacheDebug(`Deleting wrapper zip: ${wrapperZip}`)
            await tryDelete(wrapperZip)
        }
    }

    /**
     * Return the extracted cache entry definitions, which determine which artifacts will be cached
     * separately from the rest of the Gradle User Home cache entry.
     */
    protected getExtractedCacheEntryDefinitions(): ExtractedCacheEntryDefinition[] {
        const entryDefinition = (
            artifactType: string,
            patterns: string[],
            bundle: boolean
        ): ExtractedCacheEntryDefinition => {
            const resolvedPatterns = patterns
                .map(x => {
                    const isDir = x.endsWith('/')
                    const resolved = path.resolve(this.gradleUserHome, x)
                    return isDir ? `${resolved}/` : resolved // Restore trailing '/' removed by path.resolve()
                })
                .join('\n')
            return new ExtractedCacheEntryDefinition(artifactType, resolvedPatterns, bundle)
        }

        return [
            entryDefinition('generated-gradle-jars', ['caches/*/generated-gradle-jars/*.jar'], false),
            entryDefinition('wrapper-zips', ['wrapper/dists/*/*/'], false), // Each wrapper directory cached separately
            entryDefinition('java-toolchains', ['jdks/*/'], false), // Each extracted JDK cached separately
            // Sharded: these bundles are large and their directory names are content hashes, so a single
            // changed artifact need only invalidate one shard. Left unsharded are 'instrumented-jars'
            // (small, and names are prefixed 'o_' rather than hex) and 'groovy-dsl' (small).
            entryDefinition('dependencies', ['caches/modules-*/files-*/*/*/*/*'], true).withShards(),
            entryDefinition('instrumented-jars', ['caches/jars-*/*/'], true),
            entryDefinition(
                'kotlin-dsl',
                ['caches/*/kotlin-dsl/accessors/*/', 'caches/*/kotlin-dsl/scripts/*/'],
                true
            ).withShards(),
            entryDefinition('groovy-dsl', ['caches/*/groovy-dsl/*/'], true),
            entryDefinition('transforms', ['caches/transforms-4/*/', 'caches/*/transforms/*/'], true).withShards(),
            // The local build cache. Extracted for the same reason as the bundles above: it is named by
            // content hash, it grows on every build, and left in place it rides along inside the main
            // Gradle User Home entry, which is keyed on the git SHA and so is re-uploaded in full on every
            // run. 'gc.properties' and 'build-cache-1.lock' end in no hex character, so they match no shard
            // and stay where they are -- which is what is wanted for a lock file.
            entryDefinition('build-cache', ['caches/build-cache-1/*'], true).withShards()
        ]
    }
}

export class ConfigurationCacheEntryExtractor extends AbstractEntryExtractor {
    constructor(gradleUserHome: string, cacheConfig: CacheConfig) {
        super(gradleUserHome, 'configuration-cache', cacheConfig)
    }

    /**
     * Handle the case where Gradle User Home has not been fully restored, so that the configuration-cache
     * entry is not reusable.
     */
    async restore(listener: CacheListener): Promise<void> {
        if (!listener.fullyRestored) {
            this.markNotRestored(listener, 'Gradle User Home was not fully restored')
            return
        }

        if (!this.cacheConfig.getCacheEncryptionKey()) {
            this.markNotRestored(listener, 'Encryption Key was not provided')
            return
        }

        return await super.restore(listener)
    }

    private markNotRestored(listener: CacheListener, reason: string): void {
        const cacheEntries = this.loadExtractedCacheEntries()
        if (cacheEntries.length > 0) {
            core.info(`Not restoring configuration-cache state, as ${reason}`)
            for (const cacheEntry of cacheEntries) {
                listener.entry(cacheEntry.pattern).markNotRestored(reason)
            }

            // Update the results file based on no entries restored
            this.saveMetadataForCacheResults([])
        }
    }

    async extract(listener: CacheListener): Promise<void> {
        if (!this.cacheConfig.getCacheEncryptionKey()) {
            const cacheEntryDefinitions = this.getExtractedCacheEntryDefinitions()
            if (cacheEntryDefinitions.length > 0) {
                core.info('Not saving configuration-cache state, as no encryption key was provided')
                for (const cacheEntry of cacheEntryDefinitions) {
                    listener.entry(cacheEntry.pattern).markNotSaved('No encryption key provided')
                }
            }
            return
        }

        await super.extract(listener)
    }

    /**
     * Extract cache entries for the configuration cache in each project.
     */
    protected getExtractedCacheEntryDefinitions(): ExtractedCacheEntryDefinition[] {
        // Group BuildResult by existing configCacheDir
        const groupedResults = this.getConfigCacheDirectoriesWithAssociatedBuildResults()

        return Object.entries(groupedResults).map(([configCachePath, pathResults]) => {
            // Create a entry definition for each unique configuration cache directory
            const definition = new ExtractedCacheEntryDefinition(
                'configuration-cache',
                configCachePath,
                true
            ).withNonUniqueFileNames()

            // If any associated build result used Gradle < 8.6, then mark it as not cacheable
            if (
                pathResults.find(result => {
                    return !versionIsAtLeast(result.gradleVersion, '8.6.0')
                })
            ) {
                core.info(
                    `Not saving config-cache data for ${configCachePath}. Configuration cache data is only saved for Gradle 8.6+`
                )
                definition.notCacheableBecause('Configuration cache data only saved for Gradle 8.6+')
            }
            return definition
        })
    }

    private getConfigCacheDirectoriesWithAssociatedBuildResults(): Record<string, BuildResult[]> {
        return loadBuildResults().results.reduce(
            (acc, buildResult) => {
                // For each build result, find the config-cache dir
                const configCachePath = path.resolve(buildResult.rootProjectDir, '.gradle/configuration-cache')
                // Ignore case where config-cache dir doesn't exist
                if (!fs.existsSync(configCachePath)) {
                    return acc
                }

                // Group by unique config cache directories and collect associated build results
                if (!acc[configCachePath]) {
                    acc[configCachePath] = []
                }
                acc[configCachePath].push(buildResult)
                return acc
            },
            {} as Record<string, BuildResult[]>
        )
    }
}
