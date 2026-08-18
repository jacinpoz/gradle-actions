import * as core from '@actions/core'
import * as exec from '@actions/exec'

import path from 'path'
import fs from 'fs'
import {generateCacheKey} from './cache-key'
import {CacheListener} from './cache-reporting'
import {saveCache, restoreCache, cacheDebug, isCacheDebuggingEnabled, tryDelete} from './cache-utils'
import {CacheConfig, ACTION_METADATA_DIR} from '../configuration'
import {GradleHomeEntryExtractor, ConfigurationCacheEntryExtractor} from './gradle-home-extry-extractor'
import {resolveEntryPatternWithFallback} from './cache-glob'
import {getPredefinedToolchains, mergeToolchainContent, readResourceFileAsString} from './gradle-user-home-utils'

const RESTORED_CACHE_KEY_KEY = 'restored-cache-key'
const PARALLEL_RESTORE_VAR = 'GRADLE_ACTIONS_CACHE_PARALLEL_RESTORE'

/** The metadata files naming the extracted cache entries, relative to the action metadata directory. */
const ENTRY_METADATA_PATTERN = '*-entry-metadata.json'

export class GradleUserHomeCache {
    private readonly cacheName = 'home'
    private readonly cacheDescription = 'Gradle User Home'

    private readonly indexCacheName = 'home-index'
    private readonly indexCacheDescription = 'Gradle User Home entry index'

    private readonly userHome: string
    private readonly gradleUserHome: string
    private readonly cacheConfig: CacheConfig

    constructor(userHome: string, gradleUserHome: string, cacheConfig: CacheConfig) {
        this.userHome = userHome
        this.gradleUserHome = gradleUserHome
        this.cacheConfig = cacheConfig
    }

    init(): void {
        this.initializeGradleUserHome()

        // Export the GRADLE_ENCRYPTION_KEY variable if provided
        const encryptionKey = this.cacheConfig.getCacheEncryptionKey()
        if (encryptionKey) {
            core.exportVariable('GRADLE_ENCRYPTION_KEY', encryptionKey)
        }
    }

    cacheOutputExists(): boolean {
        const cachesDir = path.resolve(this.gradleUserHome, 'caches')
        if (fs.existsSync(cachesDir)) {
            cacheDebug(`Cache output exists at ${cachesDir}`)
            return true
        }
        return false
    }

    /**
     * Restores the cache entry, finding the closest match to the currently running job.
     */
    async restore(listener: CacheListener): Promise<void> {
        const entryListener = listener.entry(this.cacheDescription)

        const cacheKey = generateCacheKey(this.cacheName, this.cacheConfig)

        cacheDebug(
            `Requesting ${this.cacheDescription} with
    key:${cacheKey.key}
    restoreKeys:[${cacheKey.restoreKeys}]`
        )

        // The extracted cache entries are named in metadata files that are themselves stored inside the
        // Gradle User Home entry, so restoring them used to wait for the largest entry in the cache to
        // finish downloading. Restoring that metadata first, as a few kilobytes under a key of its own,
        // lets the Gradle User Home entry and every extracted entry transfer at the same time. Their
        // contents are disjoint: extraction deletes the extracted paths before the home is archived.
        const indexRestored = await this.restoreEntryIndex(listener)

        // Started before the Gradle User Home restore, not after: the extractor reads the metadata files
        // synchronously before it awaits anything, so beginning here guarantees the read happens before
        // the Gradle User Home archive can rewrite them with its own copy. A failure is reported and
        // otherwise ignored -- attached here rather than at the await below, so a rejection is never left
        // unhandled while the Gradle User Home entry is still downloading.
        const extractor = new GradleHomeEntryExtractor(this.gradleUserHome, this.cacheConfig)
        const extractedRestore = indexRestored
            ? extractor.restoreEntries(listener).catch(error => {
                  core.warning(`Restore of extracted cache entries failed: ${error}`)
                  return undefined
              })
            : Promise.resolve(undefined)

        const cachePath = this.getCachePath()
        const cacheResult = await restoreCache(cachePath, cacheKey.key, cacheKey.restoreKeys, entryListener)

        // Written only now that the Gradle User Home archive has finished extracting: it holds its own copy
        // of these metadata files, from before this restore, and would otherwise overwrite what was just
        // learnt about which entries are actually present.
        const restored = await extractedRestore
        if (restored) {
            extractor.persistRestored(restored)
        }

        if (!cacheResult) {
            core.info(`${this.cacheDescription} cache not found. Will initialize empty.`)
            return
        }

        core.saveState(RESTORED_CACHE_KEY_KEY, cacheResult.key)

        try {
            await this.afterRestore(listener, indexRestored)
        } catch (error) {
            core.warning(`Restore ${this.cacheDescription} failed in 'afterRestore': ${error}`)
        }
    }

    /**
     * Restore any extracted cache entries after the main Gradle User Home entry is restored.
     *
     * The Gradle Home entries are restored here only when the entry index was not available, in which case
     * the metadata naming them arrived with the Gradle User Home entry that has just been extracted.
     */
    async afterRestore(listener: CacheListener, extractedEntriesAlreadyRestored = false): Promise<void> {
        await this.debugReportGradleUserHomeSize('as restored from cache')
        if (!extractedEntriesAlreadyRestored) {
            await new GradleHomeEntryExtractor(this.gradleUserHome, this.cacheConfig).restore(listener)
        }
        await new ConfigurationCacheEntryExtractor(this.gradleUserHome, this.cacheConfig).restore(listener)
        await this.deleteExcludedPaths()
        await this.debugReportGradleUserHomeSize('after restoring common artifacts')
    }

    /**
     * Restores the metadata naming the extracted cache entries, reporting whether it was found.
     *
     * Keyed exactly as the Gradle User Home entry is, so the two always match each other: the same job,
     * matrix and commit, falling back through the same restore keys.
     */
    private async restoreEntryIndex(listener: CacheListener): Promise<boolean> {
        if (process.env[PARALLEL_RESTORE_VAR] === 'false') {
            return false
        }

        const cacheKey = generateCacheKey(this.indexCacheName, this.cacheConfig)
        const entryListener = listener.entry(this.indexCacheDescription).markMetadataOnly()
        const result = await restoreCache(this.getIndexCachePath(), cacheKey.key, cacheKey.restoreKeys, entryListener)
        return result !== undefined
    }

    private async saveEntryIndex(listener: CacheListener): Promise<void> {
        if (process.env[PARALLEL_RESTORE_VAR] === 'false') {
            return
        }

        const cacheKey = generateCacheKey(this.indexCacheName, this.cacheConfig).key
        const entryListener = listener.entry(this.indexCacheDescription).markMetadataOnly()
        await saveCache(this.getIndexCachePath(), cacheKey, entryListener)
    }

    private getIndexCachePath(): string[] {
        return [path.resolve(this.gradleUserHome, ACTION_METADATA_DIR, ENTRY_METADATA_PATTERN)]
    }

    /**
     * Saves the cache entry based on the current cache key unless the cache was restored with the exact key,
     * in which case we cannot overwrite it.
     *
     * If the cache entry was restored with a partial match on a restore key, then
     * it is saved with the exact key.
     */
    async save(listener: CacheListener): Promise<void> {
        const cacheKey = generateCacheKey(this.cacheName, this.cacheConfig).key
        const restoredCacheKey = core.getState(RESTORED_CACHE_KEY_KEY)
        const gradleHomeEntryListener = listener.entry(this.cacheDescription)

        if (restoredCacheKey && cacheKey === restoredCacheKey) {
            core.info(`Cache hit occurred on the cache key ${cacheKey}, not saving cache.`)

            for (const entryListener of listener.cacheEntries) {
                if (entryListener === gradleHomeEntryListener) {
                    entryListener.markNotSaved('cache key not changed')
                } else {
                    entryListener.markNotSaved(`referencing '${this.cacheDescription}' cache entry not saved`)
                }
            }
            return
        }

        try {
            await this.beforeSave(listener)
        } catch (error) {
            core.warning(`Save ${this.cacheDescription} failed in 'beforeSave': ${error}`)
            return
        }

        // Saved before the Gradle User Home entry: it is a few kilobytes, and the entries it names were
        // already saved by 'beforeSave', so it remains valid even if the much larger entry fails to upload.
        await this.saveEntryIndex(listener)

        const cachePath = this.getCachePath()
        await saveCache(cachePath, cacheKey, gradleHomeEntryListener)
        return
    }

    /**
     * Extract and save any defined extracted cache entries prior to the main Gradle User Home entry being saved.
     */
    async beforeSave(listener: CacheListener): Promise<void> {
        await this.debugReportGradleUserHomeSize('before saving common artifacts')
        await this.deleteExcludedPaths()
        await Promise.all([
            new GradleHomeEntryExtractor(this.gradleUserHome, this.cacheConfig).extract(listener),
            new ConfigurationCacheEntryExtractor(this.gradleUserHome, this.cacheConfig).extract(listener)
        ])
        await this.debugReportGradleUserHomeSize(
            "after extracting common artifacts (only 'caches' and 'notifications' will be stored)"
        )
    }

    /**
     * Delete any file paths that are excluded by the `gradle-home-cache-excludes` parameter.
     */
    private async deleteExcludedPaths(): Promise<void> {
        const rawPaths: string[] = this.cacheConfig.getCacheExcludes()
        rawPaths.push('caches/*/cc-keystore')
        const resolvedPaths = rawPaths.map(x => path.resolve(this.gradleUserHome, x))

        for (const excludedPath of resolvedPaths) {
            cacheDebug(`Removing excluded path: ${excludedPath}`)

            // Resolved by targeted readdir where the pattern allows it, as the entry patterns are. This
            // runs once after restoring and once before saving, and an exclusion may name as much of the
            // Gradle User Home as an entry pattern does.
            for (const toDelete of await resolveEntryPatternWithFallback(excludedPath)) {
                cacheDebug(`Removing excluded file: ${toDelete}`)
                await tryDelete(toDelete)
            }
        }
    }

    /**
     * Determines the paths within Gradle User Home to cache.
     * By default, this is the 'caches' and 'notifications' directories,
     * but this can be overridden by the `gradle-home-cache-includes` parameter.
     */
    protected getCachePath(): string[] {
        const rawPaths: string[] = this.cacheConfig.getCacheIncludes()
        rawPaths.push(ACTION_METADATA_DIR)
        const resolvedPaths = rawPaths.map(x => this.resolveCachePath(x))
        cacheDebug(`Using cache paths: ${resolvedPaths}`)
        return resolvedPaths
    }

    private resolveCachePath(rawPath: string): string {
        if (rawPath.startsWith('!')) {
            const resolved = this.resolveCachePath(rawPath.substring(1))
            return `!${resolved}`
        }
        return path.resolve(this.gradleUserHome, rawPath)
    }

    private initializeGradleUserHome(): void {
        // Create a directory for storing action metadata
        const actionCacheDir = path.resolve(this.gradleUserHome, ACTION_METADATA_DIR)
        fs.mkdirSync(actionCacheDir, {recursive: true})

        this.copyInitScripts()

        // Copy the default toolchain definitions to `~/.m2/toolchains.xml`
        this.registerToolchains()

        if (core.isDebug()) {
            this.configureInfoLogLevel()
        }
    }

    private copyInitScripts(): void {
        // Copy init scripts from src/resources to Gradle UserHome
        const initScriptsDir = path.resolve(this.gradleUserHome, 'init.d')
        fs.mkdirSync(initScriptsDir, {recursive: true})
        const initScriptFilenames = [
            'gradle-actions.build-result-capture.init.gradle',
            'gradle-actions.build-result-capture-service.plugin.groovy',
            'gradle-actions.github-dependency-graph.init.gradle',
            'gradle-actions.github-dependency-graph-gradle-plugin-apply.groovy',
            'gradle-actions.inject-develocity.init.gradle'
        ]
        for (const initScriptFilename of initScriptFilenames) {
            const initScriptContent = readResourceFileAsString('init-scripts', initScriptFilename)
            const initScriptPath = path.resolve(initScriptsDir, initScriptFilename)
            fs.writeFileSync(initScriptPath, initScriptContent)
        }
    }

    private registerToolchains(): void {
        const preInstalledToolchains: string | null = getPredefinedToolchains()
        if (preInstalledToolchains == null) return

        const m2dir = path.resolve(this.userHome, '.m2')
        const toolchainXmlTarget = path.resolve(m2dir, 'toolchains.xml')
        if (!fs.existsSync(toolchainXmlTarget)) {
            // Write a new toolchains.xml file if it doesn't exist
            fs.mkdirSync(m2dir, {recursive: true})
            fs.writeFileSync(toolchainXmlTarget, preInstalledToolchains)

            core.info(`Wrote default JDK locations to ${toolchainXmlTarget}`)
        } else {
            // Merge into an existing toolchains.xml file
            const existingToolchainContent = fs.readFileSync(toolchainXmlTarget, 'utf8')
            const mergedContent = mergeToolchainContent(existingToolchainContent, preInstalledToolchains)

            fs.writeFileSync(toolchainXmlTarget, mergedContent)
            core.info(`Merged default JDK locations into ${toolchainXmlTarget}`)
        }
    }

    /**
     * When the GitHub environment ACTIONS_RUNNER_DEBUG is true, run Gradle with --info and --stacktrace.
     * see https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/enabling-debug-logging
     *
     * @VisibleForTesting
     */
    configureInfoLogLevel(): void {
        const infoProperties = `org.gradle.logging.level=info\norg.gradle.logging.stacktrace=all\n`
        const propertiesFile = path.resolve(this.gradleUserHome, 'gradle.properties')
        if (fs.existsSync(propertiesFile)) {
            core.info(`Merged --info and --stacktrace into existing ${propertiesFile} file`)
            const existingProperties = fs.readFileSync(propertiesFile, 'utf-8')
            fs.writeFileSync(propertiesFile, `${infoProperties}\n${existingProperties}`)
        } else {
            core.info(`Created a new ${propertiesFile} with --info and --stacktrace`)
            fs.writeFileSync(propertiesFile, infoProperties)
        }
    }

    /**
     * When cache debugging is enabled (or ACTIONS_STEP_DEBUG is on),
     * this method will give a detailed report of the Gradle User Home contents.
     */
    private async debugReportGradleUserHomeSize(label: string): Promise<void> {
        if (!isCacheDebuggingEnabled() && !core.isDebug()) {
            return
        }
        if (!fs.existsSync(this.gradleUserHome)) {
            return
        }
        const result = await exec.getExecOutput('du', ['-h', '-c', '-t', '5M'], {
            cwd: this.gradleUserHome,
            silent: true,
            ignoreReturnCode: true
        })

        core.info(`Gradle User Home (directories >5M): ${label}`)

        core.info(
            result.stdout
                .trimEnd()
                .replace(/\t/g, '    ')
                .split('\n')
                .map(it => {
                    return `  ${it}`
                })
                .join('\n')
        )

        core.info('-----------------------')
    }
}
