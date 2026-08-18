import fs from 'fs'
import path from 'path'
import * as glob from '@actions/glob'

/**
 * Resolves the glob patterns used for cache entry definitions, reading only the directories a pattern
 * can actually match.
 *
 * `@actions/glob` resolves these patterns by walking the tree beneath the pattern's search root and
 * filtering the results. For a pattern anchored `caches/*` that search root is the whole Gradle User
 * Home `caches` directory, so enumerating transform directories walks every dependency file under
 * `modules-2` as well. Measured against a real Gradle User Home, resolving the `transforms` pattern
 * took 10,082 ms that way against 103 ms reading only the directories the pattern names, and the
 * `dependencies` pattern 697 ms against 42 ms.
 *
 * This resolver instead consumes the pattern segment by segment: a literal segment is followed
 * directly with no directory listing at all, and only a wildcard segment costs a `readdir`. Nothing
 * outside the matched set is ever visited. Each `readdir` reports the type of every entry it returns,
 * so classifying a match costs no further syscall unless it is a symbolic link.
 *
 * It deliberately implements only what these patterns use -- `*` within a single segment, and a
 * trailing slash meaning "directories only" -- and matches the options v5 passes to `@actions/glob`:
 * no implicit descendants, directories included, symbolic links followed, broken links omitted,
 * hidden entries included.
 */

/** Convert one path segment of a glob pattern into an anchored regular expression. */
function segmentMatcher(segment: string): (name: string) => boolean {
    if (!segment.includes('*')) {
        return name => name === segment
    }
    // '*' matches any run of characters within a segment, but never a path separator.
    const source = segment
        .split('*')
        .map(literal => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*')
    const re = new RegExp(`^${source}$`)
    return name => re.test(name)
}

/**
 * Whether a path is a directory, following symbolic links. Broken links and races against a
 * concurrently changing cache resolve to false rather than throwing.
 */
function isDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory()
    } catch {
        return false
    }
}

/** Whether a path exists at all, following symbolic links. */
function exists(candidate: string): boolean {
    try {
        fs.statSync(candidate)
        return true
    } catch {
        return false
    }
}

function readDirents(dir: string): fs.Dirent[] {
    try {
        return fs.readdirSync(dir, {withFileTypes: true})
    } catch {
        // The directory may not exist for this Gradle version, or may have been removed mid-run.
        return []
    }
}

/**
 * Whether a directory entry is a directory, following symbolic links.
 *
 * `readdir` already reports each entry's type, so the common case costs no syscall at all. A `Dirent`
 * describes the link rather than its target, so only a symbolic link still needs a `stat`.
 */
function direntIsDirectory(entry: fs.Dirent, full: string): boolean {
    return entry.isSymbolicLink() ? isDirectory(full) : entry.isDirectory()
}

/** Whether a directory entry resolves to anything: only a broken symbolic link does not. */
function direntExists(entry: fs.Dirent, full: string): boolean {
    return entry.isSymbolicLink() ? exists(full) : true
}

/**
 * Split a pattern into its filesystem root and the segments below it.
 *
 * The root has to come from `path.parse` rather than being rebuilt from a separator. On Windows a
 * pattern begins with a drive letter, and joining `D:` onto a leading `\` yields `\D:\...`, a path
 * rooted on the current drive that cannot exist -- so every absolute pattern resolved to nothing and
 * nothing was cached at all. This also keeps UNC roots such as `\\server\share\` intact.
 *
 * `pathApi` is a parameter only so that both platforms can be tested from either.
 */
export function splitPatternRoot(normalized: string, pathApi: typeof path = path): {root: string; segments: string[]} {
    const root = pathApi.parse(normalized).root
    const segments = normalized
        .slice(root.length)
        .split(pathApi.sep)
        .filter(segment => segment.length > 0)
    return {root, segments}
}

/**
 * Resolve a single-line absolute glob pattern.
 *
 * A trailing slash restricts matches to directories; without one, files and directories both match,
 * as with `matchDirectories: true`.
 */
export function resolvePatternLine(pattern: string): string[] {
    const directoriesOnly = pattern.endsWith('/')
    const normalized = directoriesOnly ? pattern.slice(0, -1) : pattern

    const {root: patternRoot, segments} = splitPatternRoot(normalized)
    if (segments.length === 0) {
        return []
    }

    // Follow the leading literal segments without listing anything: this is what keeps the resolver
    // off unrelated subtrees such as modules-2 when matching transforms.
    let index = 0
    let root = patternRoot
    while (index < segments.length && !segments[index].includes('*')) {
        root = path.join(root, segments[index])
        index++
    }

    if (index === segments.length) {
        // Fully literal pattern.
        if (!exists(root) || (directoriesOnly && !isDirectory(root))) {
            return []
        }
        return [root]
    }

    if (!isDirectory(root)) {
        return []
    }

    // Expand the remaining segments one level at a time.
    let current = [root]
    for (let i = index; i < segments.length; i++) {
        const isLastSegment = i === segments.length - 1
        const segment = segments[i]

        if (!segment.includes('*')) {
            // A literal segment after a wildcard: probe each candidate rather than listing it.
            const next: string[] = []
            for (const dir of current) {
                const candidate = path.join(dir, segment)
                if (isLastSegment ? exists(candidate) : isDirectory(candidate)) {
                    next.push(candidate)
                }
            }
            current = next
            continue
        }

        const matches = segmentMatcher(segment)
        const next: string[] = []
        for (const dir of current) {
            // `dir` is already normalized and an entry name never contains a separator, so the child
            // path is a concatenation; path.join would re-normalize both halves once per entry.
            const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep
            for (const entry of readDirents(dir)) {
                if (!matches(entry.name)) {
                    continue
                }
                const candidate = prefix + entry.name
                // Intermediate segments must be directories to descend into; only the final segment
                // may match a file, and only when the pattern did not end in a slash.
                if (isLastSegment) {
                    if (directoriesOnly ? direntIsDirectory(entry, candidate) : direntExists(entry, candidate)) {
                        next.push(candidate)
                    }
                } else if (direntIsDirectory(entry, candidate)) {
                    next.push(candidate)
                }
            }
        }
        current = next
    }

    return current
}

/**
 * Resolve a cache entry pattern, which may hold several newline-separated patterns.
 *
 * Results are de-duplicated and sorted so that the file-name hash used for cache keys is stable:
 * the key must not depend on directory iteration order.
 */
export function resolveEntryPattern(pattern: string): string[] {
    const all = new Set<string>()
    for (const line of pattern.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) {
            continue
        }
        for (const match of resolvePatternLine(trimmed)) {
            all.add(match)
        }
    }
    return [...all].sort()
}

/**
 * The directories that could contain a match of the pattern, one per line of it: the deepest directory
 * above the first wildcard segment, or the containing directory of a fully literal pattern.
 *
 * Used to create those directories before several `tar` processes extract into the same tree at once, so
 * that none of them races another to create a shared parent.
 */
export function matchedEntryParents(pattern: string): string[] {
    return patternLines(pattern).map(line => {
        const normalized = line.endsWith('/') ? line.slice(0, -1) : line
        const {root, segments} = splitPatternRoot(normalized)

        let parent = root
        for (const [index, segment] of segments.entries()) {
            if (segment.includes('*')) {
                return parent
            }
            // A fully literal pattern names the match itself, so its parent is one level up.
            if (index === segments.length - 1) {
                return parent
            }
            parent = path.join(parent, segment)
        }
        return parent
    })
}

/**
 * Whether this resolver implements everything the given pattern uses.
 *
 * The cache entry patterns this action defines use only `*` within a single segment and a trailing
 * slash. The Gradle User Home entry, though, is built from the `gradle-home-cache-includes` and
 * `gradle-home-cache-excludes` inputs, so a user can supply `**`, an `!` exclusion, or any other
 * shape `@actions/glob` accepts. Anything not listed here is left to `@actions/glob`.
 */
export function canResolvePatternLine(pattern: string): boolean {
    return !pattern.startsWith('!') && !pattern.includes('**') && !/[?[\]{}()]/.test(pattern)
}

/** Splits a pattern into its non-empty lines. */
function patternLines(pattern: string): string[] {
    return pattern
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
}

/**
 * Resolves a pattern with this resolver where it can, and with `@actions/glob` where it cannot.
 *
 * Used for patterns that come from action inputs rather than from the entry definitions, where any shape
 * `@actions/glob` accepts is legal.
 *
 * The gain here is small, unlike for the entry patterns: `@actions/glob` prunes a subtree as soon as it
 * cannot partially match, so the default exclusion `caches/*\/cc-keystore` costs it 3 ms against 0 ms for
 * this resolver on a Gradle User Home of 186k paths. What it does buy is that an exclusion of the shape the
 * entry definitions use no longer pays `@actions/glob`'s per-path matching cost, which is what makes it 84x
 * slower on a pattern that matches a lot.
 */
export async function resolveEntryPatternWithFallback(pattern: string): Promise<string[]> {
    const lines = patternLines(pattern)
    if (lines.length > 0 && lines.every(canResolvePatternLine)) {
        return resolveEntryPattern(lines.join('\n'))
    }

    const globber = await glob.create(pattern, {implicitDescendants: false})
    return globber.glob()
}

/**
 * Paths registered by `withExplicitPaths`, keyed by the normalized pattern they stand in for.
 */
const explicitPaths = new Map<string, {paths: string[]; refCount: number}>()

/** The key a set of pattern lines is registered under. */
function patternKey(patterns: string[]): string {
    return patternLines(patterns.join('\n')).join('\n')
}

/**
 * Runs `action` with the paths `@actions/cache` should archive for `patterns` supplied directly, instead of
 * resolved from the patterns again.
 *
 * The caller has usually already resolved the pattern -- and, for a sharded bundle, partitioned the result
 * -- so resolving it a second time inside `@actions/cache` repeats the same directory reads once per shard.
 * It also lets an entry archive a subset of what its pattern matches, which is what makes an incremental
 * layer possible: the pattern still determines the cache version, so save and restore agree, while the
 * archive holds only the paths the caller names.
 *
 * The registration is scoped to `action` and reference counted, so a pattern is never left overridden. If
 * the same pattern is somehow registered twice with different paths, neither override is applied and the
 * paths are resolved normally: archiving the wrong content would be worse than repeating the work.
 */
export async function withExplicitPaths<T>(patterns: string[], paths: string[], action: () => Promise<T>): Promise<T> {
    const key = patternKey(patterns)
    const existing = explicitPaths.get(key)

    if (existing && !samePaths(existing.paths, paths)) {
        return action()
    }

    if (existing) {
        existing.refCount++
    } else {
        explicitPaths.set(key, {paths, refCount: 1})
    }

    try {
        return await action()
    } finally {
        const registered = explicitPaths.get(key)
        if (registered && --registered.refCount <= 0) {
            explicitPaths.delete(key)
        }
    }
}

function samePaths(one: string[], other: string[]): boolean {
    return one.length === other.length && one.every((entry, index) => entry === other[index])
}

/**
 * Resolves the paths for a set of patterns on behalf of `@actions/cache`, or returns undefined to
 * leave them to `@actions/glob`.
 *
 * `@actions/cache` resolves the paths it archives itself, with `@actions/glob`, so saving a cache
 * entry repeated the walk this resolver exists to avoid -- once per entry, and the action shards the
 * largest entries into 16. Registered via `cache.setPathResolver`, which is added by the
 * patch-package patch on that library.
 */
export function resolvePathsForCache(patterns: string[]): string[] | undefined {
    const lines = patternLines(patterns.join('\n'))

    const explicit = explicitPaths.get(lines.join('\n'))
    if (explicit) {
        return explicit.paths
    }

    if (lines.length === 0 || !lines.every(canResolvePatternLine)) {
        return undefined
    }
    return resolveEntryPattern(lines.join('\n'))
}
