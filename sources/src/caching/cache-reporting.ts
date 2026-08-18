import * as cache from '@actions/cache'

export const DEFAULT_CACHE_ENABLED_REASON = `[Cache was enabled](https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#caching-build-state-between-jobs). Action attempted to both restore and save the Gradle User Home.`

export const DEFAULT_READONLY_REASON = `[Cache was read-only](https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#using-the-cache-read-only). By default, the action will only write to the cache for Jobs running on the default branch.`

export const DEFAULT_DISABLED_REASON = `[Cache was disabled](https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#disabling-caching). Gradle User Home was not restored from or saved to the cache.`

export const DEFAULT_WRITEONLY_REASON = `[Cache was set to write-only](https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#using-the-cache-write-only). Gradle User Home was not restored from cache.`

export const EXISTING_GRADLE_HOME = `[Cache was disabled to avoid overwriting a pre-existing Gradle User Home](https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#overwriting-an-existing-gradle-user-home). Gradle User Home was not restored from or saved to the cache.`

export const CLEANUP_DISABLED_READONLY = `[Cache cleanup](https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#configuring-cache-cleanup) is always disabled when cache is read-only or disabled.`

export const DEFAULT_CLEANUP_ENABLED_REASON = `[Cache cleanup](https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#configuring-cache-cleanup) was enabled. Stale files in Gradle User Home were purged before saving to the cache.`

export const DEFAULT_CLEANUP_DISABLED_REASON = `[Cache cleanup](https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#configuring-cache-cleanup) was disabled via action parameter. No cleanup of Gradle User Home was performed.`

export const CLEANUP_DISABLED_DUE_TO_FAILURE =
    '[Cache cleanup was disabled due to build failure](https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#configuring-cache-cleanup). Use `cache-cleanup: always` to override this behavior.'

export const CLEANUP_DISABLED_DUE_TO_CONFIG_CACHE_HIT =
    '[Cache cleanup was disabled due to configuration-cache reuse](https://github.com/gradle/actions/blob/main/docs/setup-gradle.md#configuring-cache-cleanup). This is expected.'

/**
 * Collects information on what entries were saved and restored during the action.
 * This information is used to generate a summary of the cache usage.
 */
export class CacheListener {
    cacheEntries: CacheEntryListener[] = []

    /**
     * Wall-clock totals for work the action does itself, outside the `@actions/cache` calls that
     * `CacheEntryListener` already times: resolving entry patterns, hashing cache keys, and deleting
     * extracted content from the Gradle User Home.
     *
     * On a large Gradle User Home these phases dominate, and none of them are visible in the per-entry
     * restore and save times, so a regression in any of them is otherwise invisible in the job summary.
     */
    phaseTotals: Record<string, number> = {}
    cacheReadOnly = false
    cacheWriteOnly = false
    cacheDisabled = false
    cacheStatusReason: string = DEFAULT_CACHE_ENABLED_REASON
    cacheCleanupMessage: string = DEFAULT_CLEANUP_DISABLED_REASON

    get fullyRestored(): boolean {
        // Metadata entries are excluded: they describe the cache rather than holding Gradle User Home
        // content, so missing one costs a slower restore, not an incomplete one. Counting them here would
        // suppress the configuration-cache restore for a run whose content was in fact fully restored.
        return this.cacheEntries.every(x => x.metadataOnly || !x.wasRequestedButNotRestored())
    }

    get cacheStatus(): string {
        if (!cache.isFeatureAvailable()) return 'not available'
        if (this.cacheDisabled) return 'disabled'
        if (this.cacheWriteOnly) return 'write-only'
        if (this.cacheReadOnly) return 'read-only'
        return 'enabled'
    }

    setReadOnly(reason: string = DEFAULT_READONLY_REASON): void {
        this.cacheReadOnly = true
        this.cacheStatusReason = reason
        this.cacheCleanupMessage = CLEANUP_DISABLED_READONLY
    }

    setDisabled(reason: string = DEFAULT_DISABLED_REASON): void {
        this.cacheDisabled = true
        this.cacheStatusReason = reason
        this.cacheCleanupMessage = CLEANUP_DISABLED_READONLY
    }

    setWriteOnly(reason: string = DEFAULT_WRITEONLY_REASON): void {
        this.cacheWriteOnly = true
        this.cacheStatusReason = reason
    }

    setCacheCleanupEnabled(): void {
        this.cacheCleanupMessage = DEFAULT_CLEANUP_ENABLED_REASON
    }

    setCacheCleanupDisabled(reason: string = DEFAULT_CLEANUP_DISABLED_REASON): void {
        this.cacheCleanupMessage = reason
    }

    addPhaseTime(phase: string, milliseconds: number): void {
        this.phaseTotals[phase] = (this.phaseTotals[phase] ?? 0) + milliseconds
    }

    entry(name: string): CacheEntryListener {
        for (const entry of this.cacheEntries) {
            if (entry.entryName === name) {
                return entry
            }
        }

        const newEntry = new CacheEntryListener(name)
        this.cacheEntries.push(newEntry)
        return newEntry
    }

    stringify(): string {
        return JSON.stringify(this)
    }

    static rehydrate(stringRep: string): CacheListener {
        if (stringRep === '') {
            return new CacheListener()
        }
        const rehydrated: CacheListener = Object.assign(new CacheListener(), JSON.parse(stringRep))
        // State written by an older version of the action has no phase totals.
        rehydrated.phaseTotals = rehydrated.phaseTotals ?? {}
        const entries = rehydrated.cacheEntries
        for (let index = 0; index < entries.length; index++) {
            const rawEntry = entries[index]
            entries[index] = Object.assign(new CacheEntryListener(rawEntry.entryName), rawEntry)
        }
        return rehydrated
    }
}

/**
 * Collects information on the state of a single cache entry.
 */
export class CacheEntryListener {
    entryName: string
    requestedKey: string | undefined
    requestedRestoreKeys: string[] | undefined
    restoredKey: string | undefined
    restoredSize: number | undefined
    restoredTime: number | undefined
    notRestored: string | undefined

    savedKey: string | undefined
    savedSize: number | undefined
    savedTime: number | undefined
    notSaved: string | undefined

    /** Time spent hashing this entry's cache key, and deleting its content from the Gradle User Home. */
    keyMs: number | undefined
    deleteMs: number | undefined

    /** Set for an entry that holds metadata about the cache rather than Gradle User Home content. */
    metadataOnly = false

    constructor(entryName: string) {
        this.entryName = entryName
    }

    wasRequestedButNotRestored(): boolean {
        return this.requestedKey !== undefined && this.restoredKey === undefined
    }

    markRequested(key: string, restoreKeys: string[] = []): CacheEntryListener {
        this.requestedKey = key
        this.requestedRestoreKeys = restoreKeys
        return this
    }

    markRestored(key: string, size: number | undefined, time: number): CacheEntryListener {
        this.restoredKey = key
        this.restoredSize = size
        this.restoredTime = time
        return this
    }

    markNotRestored(message: string): CacheEntryListener {
        this.notRestored = message
        return this
    }

    markSaved(key: string, size: number | undefined, time: number): CacheEntryListener {
        this.savedKey = key
        this.savedSize = size
        this.savedTime = time
        return this
    }

    markAlreadyExists(key: string): CacheEntryListener {
        this.savedKey = key
        this.savedSize = 0
        return this
    }

    markNotSaved(message: string): CacheEntryListener {
        this.notSaved = message
        return this
    }

    markMetadataOnly(): CacheEntryListener {
        this.metadataOnly = true
        return this
    }

    markKeyTime(milliseconds: number): CacheEntryListener {
        this.keyMs = milliseconds
        return this
    }

    markDeleteTime(milliseconds: number): CacheEntryListener {
        this.deleteMs = milliseconds
        return this
    }
}

/** Records the wall-clock time a synchronous phase took, and returns both. */
export function measure<T>(action: () => T): {result: T; milliseconds: number} {
    const startTime = Date.now()
    const result = action()
    return {result, milliseconds: Date.now() - startTime}
}

export function generateCachingReport(listener: CacheListener): string {
    const entries = listener.cacheEntries

    return `
<details>
<summary><h4>Caching for Gradle actions was ${listener.cacheStatus} - expand for details</h4></summary>

- ${listener.cacheStatusReason}
- ${listener.cacheCleanupMessage}

${renderEntryTable(entries)}
${renderPhaseTable(listener)}

<h5>Cache Entry Details</h5>
<pre>
    ${renderEntryDetails(listener)}
</pre>
</details>
    `
}

function renderEntryTable(entries: CacheEntryListener[]): string {
    return `
<table>
    <tr><td></td><th>Count</th><th>Total Size (Mb)</th><th>Total Time (ms)</tr>
    <tr><td>Entries Restored</td>
        <td>${getCount(entries, e => e.restoredSize)}</td>
        <td>${getSize(entries, e => e.restoredSize)}</td>
        <td>${getTime(entries, e => e.restoredTime)}</td>
    </tr>
    <tr><td>Entries Saved</td>
        <td>${getCount(entries, e => e.savedSize)}</td>
        <td>${getSize(entries, e => e.savedSize)}</td>
        <td>${getTime(entries, e => e.savedTime)}</td>
    </tr>
</table>
    `
}

/**
 * Renders the time spent in the action's own phases, if any was recorded. Nothing is emitted when no
 * phase ran, so a job with caching disabled does not grow an empty table.
 */
function renderPhaseTable(listener: CacheListener): string {
    const entries = listener.cacheEntries
    const phases: [string, number][] = [
        ...Object.entries(listener.phaseTotals),
        ['hash cache keys', getTime(entries, e => e.keyMs)],
        ['delete extracted content', getTime(entries, e => e.deleteMs)]
    ]
    const timedPhases = phases.filter(([, milliseconds]) => milliseconds > 0)

    if (timedPhases.length === 0) {
        return ''
    }

    const rows = timedPhases
        .map(([phase, milliseconds]) => `    <tr><td>${phase}</td><td>${milliseconds}</td></tr>`)
        .join('\n')
    return `
<table>
    <tr><th>Action Phase</th><th>Total Time (ms)</th></tr>
${rows}
</table>
    `
}

function renderEntryDetails(listener: CacheListener): string {
    return listener.cacheEntries
        .map(
            entry => `Entry: ${entry.entryName}
    Requested Key : ${entry.requestedKey ?? ''}
    Restored  Key : ${entry.restoredKey ?? ''}
              Size: ${formatSize(entry.restoredSize)}
              Time: ${formatTime(entry.restoredTime)}
              ${getRestoredMessage(entry, listener.cacheWriteOnly)}
    Saved     Key : ${entry.savedKey ?? ''}
              Size: ${formatSize(entry.savedSize)}
              Time: ${formatTime(entry.savedTime)}
              ${getSavedMessage(entry, listener.cacheReadOnly)}
${renderEntryPhases(entry)}`
        )
        .join('---\n')
}

function renderEntryPhases(entry: CacheEntryListener): string {
    const phases: [string, number | undefined][] = [
        ['Key  Time', entry.keyMs],
        ['Del  Time', entry.deleteMs]
    ]

    return phases
        .filter(([, milliseconds]) => milliseconds !== undefined && milliseconds > 0)
        .map(([label, milliseconds]) => `    ${label} : ${formatTime(milliseconds)}\n`)
        .join('')
}

function getRestoredMessage(entry: CacheEntryListener, cacheWriteOnly: boolean): string {
    if (entry.notRestored) {
        return `(Entry not restored: ${entry.notRestored})`
    }
    if (cacheWriteOnly) {
        return '(Entry not restored: cache is write-only)'
    }
    if (entry.requestedKey === undefined) {
        return '(Entry not restored: not requested)'
    }
    if (entry.restoredKey === undefined) {
        return '(Entry not restored: no match found)'
    }
    if (entry.restoredKey === entry.requestedKey) {
        return '(Entry restored: exact match found)'
    }
    return '(Entry restored: partial match found)'
}

function getSavedMessage(entry: CacheEntryListener, cacheReadOnly: boolean): string {
    if (entry.notSaved) {
        return `(Entry not saved: ${entry.notSaved})`
    }
    if (entry.savedKey === undefined) {
        if (cacheReadOnly) {
            return '(Entry not saved: cache is read-only)'
        }
        if (entry.notRestored) {
            return '(Entry not saved: not restored)'
        }
        return '(Entry not saved: reason unknown)'
    }
    if (entry.savedSize === 0) {
        return '(Entry not saved: entry with key already exists)'
    }
    return '(Entry saved)'
}

function getCount(
    cacheEntries: CacheEntryListener[],
    predicate: (value: CacheEntryListener) => number | undefined
): number {
    return cacheEntries.filter(e => predicate(e)).length
}

function getSize(
    cacheEntries: CacheEntryListener[],
    predicate: (value: CacheEntryListener) => number | undefined
): number {
    const bytes = cacheEntries.map(e => predicate(e) ?? 0).reduce((p, v) => p + v, 0)
    return Math.round(bytes / (1024 * 1024))
}

function getTime(
    cacheEntries: CacheEntryListener[],
    predicate: (value: CacheEntryListener) => number | undefined
): number {
    return cacheEntries.map(e => predicate(e) ?? 0).reduce((p, v) => p + v, 0)
}

function formatSize(bytes: number | undefined): string {
    if (bytes === undefined || bytes === 0) {
        return ''
    }
    return `${Math.round(bytes / (1024 * 1024))} MB (${bytes} B)`
}

function formatTime(ms: number | undefined): string {
    if (ms === undefined || ms === 0) {
        return ''
    }
    return `${ms} ms`
}
