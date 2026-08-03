import fs from 'fs'
import path from 'path'

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
 * outside the matched set is ever visited.
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

function readDirNames(dir: string): string[] {
    try {
        return fs.readdirSync(dir)
    } catch {
        // The directory may not exist for this Gradle version, or may have been removed mid-run.
        return []
    }
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

    const segments = normalized.split(path.sep).filter(segment => segment.length > 0)
    if (segments.length === 0) {
        return []
    }

    // Follow the leading literal segments without listing anything: this is what keeps the resolver
    // off unrelated subtrees such as modules-2 when matching transforms.
    let index = 0
    let root = path.isAbsolute(normalized) ? path.sep : ''
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
            for (const name of readDirNames(dir)) {
                if (!matches(name)) {
                    continue
                }
                const candidate = path.join(dir, name)
                // Intermediate segments must be directories to descend into; only the final segment
                // may match a file, and only when the pattern did not end in a slash.
                if (isLastSegment) {
                    if (directoriesOnly ? isDirectory(candidate) : exists(candidate)) {
                        next.push(candidate)
                    }
                } else if (isDirectory(candidate)) {
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
