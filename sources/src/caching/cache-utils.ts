import * as core from '@actions/core'
import * as cache from '@actions/cache'
import * as exec from '@actions/exec'

import * as crypto from 'crypto'
import * as path from 'path'
import * as fs from 'fs'

import {CacheEntryListener} from './cache-reporting'

const SEGMENT_DOWNLOAD_TIMEOUT_VAR = 'SEGMENT_DOWNLOAD_TIMEOUT_MINS'
const SEGMENT_DOWNLOAD_TIMEOUT_DEFAULT = 10 * 60 * 1000 // 10 minutes

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

export async function saveCache(cachePath: string[], cacheKey: string, listener: CacheEntryListener): Promise<void> {
    try {
        const startTime = Date.now()
        const savedEntry = await cache.saveCache(cachePath, cacheKey)
        const saveTime = Date.now() - startTime
        listener.markSaved(savedEntry.key, savedEntry.size, saveTime)
        core.info(`Saved cache entry with key ${cacheKey} from ${cachePath.join()} in ${saveTime}ms`)
    } catch (error) {
        if (error instanceof cache.ReserveCacheError) {
            listener.markAlreadyExists(cacheKey)
        } else {
            listener.markNotSaved((error as Error).message)
        }
        handleCacheFailure(error, `Failed to save cache entry with path '${cachePath}' and key: ${cacheKey}`)
    }
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
