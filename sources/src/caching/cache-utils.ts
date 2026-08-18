import * as core from '@actions/core'
import * as cache from '@actions/cache'
import * as exec from '@actions/exec'

import * as crypto from 'crypto'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

import {CacheEntryListener} from './cache-reporting'
import {resolvePathsForCache} from './cache-glob'

// '@actions/cache' resolves the paths it archives with '@actions/glob', which walks the whole tree
// beneath a pattern's search root. Registering the resolver here means every save goes through the
// targeted readdir path instead, and anything the resolver does not implement still falls back.
cache.setPathResolver(resolvePathsForCache)

const SEGMENT_DOWNLOAD_TIMEOUT_VAR = 'SEGMENT_DOWNLOAD_TIMEOUT_MINS'
const SEGMENT_DOWNLOAD_TIMEOUT_DEFAULT = 10 * 60 * 1000 // 10 minutes

const ENTRY_CONCURRENCY_VAR = 'GRADLE_ACTIONS_CACHE_ENTRY_CONCURRENCY'

/**
 * How many paths to delete between yields to the event loop.
 *
 * Deleting synchronously is the fastest way to do it -- measured over 20k extracted directories, `rmSync`
 * in a loop took 218 ms against 368 ms for `fs.promises.rm` 32 at a time -- but it takes the loop with it:
 * that loop got 0 of the 21 turns it was due, so every cache entry that was supposed to be uploading
 * alongside it made no progress at all. Yielding this often keeps the speed and returns the turns: 207 ms,
 * and all 20 of them.
 */
const DELETE_YIELD_INTERVAL = 64

/**
 * How many cache entries to restore or save at once.
 *
 * Each entry runs a `tar` piped through `zstdmt -T0` and, when restoring, eight concurrent range requests
 * buffered at 4 MiB. A large Gradle User Home defines around fifty entries once the big bundles are
 * sharded, so an unbounded fan-out puts fifty multi-threaded compressors on a four-core runner and holds
 * more than a gigabyte of download buffers. Bounding it trades no throughput -- the transfers are already
 * concurrent within each entry -- for much less contention.
 */
export function entryConcurrency(): number {
    const override = Number(process.env[ENTRY_CONCURRENCY_VAR])
    if (Number.isInteger(override) && override > 0) {
        return override
    }
    return Math.min(8, Math.max(4, os.cpus().length))
}

/**
 * Applies `action` to every item with at most `limit` in flight, preserving the order of the results.
 */
export async function mapConcurrently<T, R>(items: T[], limit: number, action: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length)
    let nextIndex = 0

    const worker = async (): Promise<void> => {
        for (let index = nextIndex++; index < items.length; index = nextIndex++) {
            results[index] = await action(items[index])
        }
    }

    await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker))
    return results
}

export function isCacheDebuggingEnabled(): boolean {
    if (core.isDebug()) {
        return true
    }
    return process.env['GRADLE_BUILD_ACTION_CACHE_DEBUG_ENABLED'] ? true : false
}

/**
 * Rewrites path separators to '/', so that a cache key does not depend on the platform that wrote it.
 *
 * On POSIX the rewrite is a no-op and the names are returned untouched. v5 built a fresh RegExp per
 * name to rewrite '/' to '/', which cost 78% of hashFileNames on a 177k-path Gradle User Home.
 *
 * `sep` is a parameter only so both platforms can be tested from either: `path.sep` is declared
 * non-configurable, so a test cannot pretend to be running on the other one.
 */
export function normalizeFileNames(fileNames: string[], sep: string = path.sep): string[] {
    return sep === '/' ? fileNames : fileNames.map(x => x.split(sep).join('/'))
}

export function hashFileNames(fileNames: string[]): string {
    return hashStrings(normalizeFileNames(fileNames))
}

export function hashStrings(values: string[]): string {
    const hash = crypto.createHash('md5')
    for (const value of values) {
        hash.update(value)
    }
    return hash.digest('hex')
}

export async function restoreCache(
    cachePath: string[],
    cacheKey: string,
    cacheRestoreKeys: string[],
    listener: CacheEntryListener
): Promise<cache.CacheEntry | undefined> {
    listener.markRequested(cacheKey, cacheRestoreKeys)
    try {
        const startTime = Date.now()
        // Only override the read timeout if the SEGMENT_DOWNLOAD_TIMEOUT_MINS env var has NOT been set
        const cacheRestoreOptions = process.env[SEGMENT_DOWNLOAD_TIMEOUT_VAR]
            ? {}
            : {segmentTimeoutInMs: SEGMENT_DOWNLOAD_TIMEOUT_DEFAULT}
        const restoredEntry = await cache.restoreCache(cachePath, cacheKey, cacheRestoreKeys, cacheRestoreOptions)
        if (restoredEntry !== undefined) {
            const restoreTime = Date.now() - startTime
            listener.markRestored(restoredEntry.key, restoredEntry.size, restoreTime)
            core.info(`Restored cache entry with key ${cacheKey} to ${cachePath.join()} in ${restoreTime}ms`)
        }
        return restoredEntry
    } catch (error) {
        listener.markNotRestored((error as Error).message)
        handleCacheFailure(error, `Failed to restore ${cacheKey}`)
        return undefined
    }
}

/**
 * Saves a cache entry, reporting the size of the archive that was stored.
 *
 * The size is what tells a later run how large this entry has become, and so how many shards its bundle
 * should be split across. It is undefined when the entry could not be saved, or already existed.
 */
export async function saveCache(
    cachePath: string[],
    cacheKey: string,
    listener: CacheEntryListener
): Promise<number | undefined> {
    try {
        const startTime = Date.now()
        const savedEntry = await cache.saveCache(cachePath, cacheKey)
        const saveTime = Date.now() - startTime
        listener.markSaved(savedEntry.key, savedEntry.size, saveTime)
        core.info(`Saved cache entry with key ${cacheKey} from ${cachePath.join()} in ${saveTime}ms`)
        return savedEntry.size
    } catch (error) {
        if (error instanceof cache.CacheWriteDeniedError) {
            // The cache token issued for this run is read-only, which the service does for an untrusted
            // event such as a pull request from a fork. This must be tested before ReserveCacheError,
            // which it extends, or a denied write is reported as an entry that already exists.
            listener.markNotSaved('cache write denied for this run')
        } else if (error instanceof cache.ReserveCacheError) {
            listener.markAlreadyExists(cacheKey)
        } else {
            listener.markNotSaved((error as Error).message)
        }
        handleCacheFailure(error, `Failed to save cache entry with path '${cachePath}' and key: ${cacheKey}`)
    }
    return undefined
}

export function cacheDebug(message: string): void {
    if (isCacheDebuggingEnabled()) {
        core.info(message)
    } else {
        core.debug(message)
    }
}

export function handleCacheFailure(error: unknown, message: string): void {
    if (error instanceof cache.ValidationError) {
        // Fail on cache validation errors
        throw error
    }
    if (error instanceof cache.ReserveCacheError) {
        // Reserve cache errors are expected if the artifact has been previously cached
        core.info(`${message}: ${error}`)
    } else {
        // Warn on all other errors
        core.warning(`${message}: ${error}`)
        if (error instanceof Error && error.stack) {
            cacheDebug(error.stack)
        }
    }
}

/**
 * Deletes every given path, giving the event loop a turn as it goes so that the cache entries uploading
 * alongside make progress. See `DELETE_YIELD_INTERVAL`.
 *
 * A path that cannot be deleted is reported by `tryDelete` and then skipped: it stays in the Gradle User
 * Home and is stored in the main cache entry instead, which is where it would have lived had it never been
 * extracted. Failing the whole save for one locked file would lose every other entry as well.
 */
export async function deleteAll(files: string[]): Promise<void> {
    let failed = 0

    for (let index = 0; index < files.length; index++) {
        try {
            await tryDelete(files[index])
        } catch (error) {
            failed++
            cacheDebug(`Failed to delete ${files[index]}: ${(error as Error).message}`)
        }
        if ((index + 1) % DELETE_YIELD_INTERVAL === 0) {
            await yieldToEventLoop()
        }
    }

    if (failed > 0) {
        core.warning(`Failed to delete ${failed} of ${files.length} extracted cache entry paths.`)
    }
}

async function yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve))
}

/**
 * Attempt to delete a file or directory, waiting to allow locks to be released
 */
export async function tryDelete(file: string): Promise<void> {
    const maxAttempts = 5
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            // `force` removes a path that is already gone, and `recursive` covers a directory, so
            // neither an existsSync nor an lstatSync is needed to choose between them. Those two
            // probes cost a fifth of the time to delete 20k extracted entries. Any other failure --
            // a file locked by another process, which is what the retry below exists for -- still
            // throws.
            //
            fs.rmSync(file, {recursive: true, force: true})
            return
        } catch (error) {
            if (attempt === maxAttempts) {
                core.warning(`Failed to delete ${file}, which will impact caching. 
It is likely locked by another process. Output of 'jps -ml':
${await getJavaProcesses()}`)
                throw error
            } else {
                cacheDebug(`Attempt to delete ${file} failed. Will try again.`)
                await delay(1000)
            }
        }
    }
}

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function getJavaProcesses(): Promise<string> {
    const jpsOutput = await exec.getExecOutput('jps', ['-lm'])
    return jpsOutput.stdout
}
