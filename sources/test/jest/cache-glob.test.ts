import fs from 'fs'
import os from 'os'
import path from 'path'
import {
    canResolvePatternLine,
    matchedEntryParents,
    resolveEntryPattern,
    resolveEntryPatternWithFallback,
    resolvePathsForCache,
    resolvePatternLine,
    splitPatternRoot,
    withExplicitPaths
} from '../../src/caching/cache-glob'

let root: string

function mk(...parts: string[]): string {
    const p = path.join(root, ...parts)
    fs.mkdirSync(p, {recursive: true})
    return p
}

function touch(relative: string, contents = 'x'): string {
    const p = path.join(root, relative)
    fs.mkdirSync(path.dirname(p), {recursive: true})
    fs.writeFileSync(p, contents)
    return p
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-glob-'))
})

afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true})
})

describe('resolvePatternLine', () => {
    it('matches a single wildcard segment', () => {
        mk('caches', '9.6.1', 'transforms', 'aaa')
        mk('caches', '9.6.1', 'transforms', 'bbb')
        const found = resolvePatternLine(path.join(root, 'caches/*/transforms/*/'))
        expect(found.sort()).toEqual([
            path.join(root, 'caches/9.6.1/transforms/aaa'),
            path.join(root, 'caches/9.6.1/transforms/bbb')
        ])
    })

    it('does not descend into sibling subtrees the pattern cannot match', () => {
        // The point of the resolver: modules-2 must never be walked to enumerate transforms.
        mk('caches', '9.6.1', 'transforms', 'aaa')
        touch('caches/modules-2/files-2.1/g/m/1.0/deadbeef/m-1.0.jar')
        const found = resolvePatternLine(path.join(root, 'caches/*/transforms/*/'))
        expect(found).toEqual([path.join(root, 'caches/9.6.1/transforms/aaa')])
    })

    it('honours a trailing slash by matching directories only', () => {
        mk('caches', 'jars-9', 'dir')
        touch('caches/jars-9/file')
        expect(resolvePatternLine(path.join(root, 'caches/jars-*/*/'))).toEqual([path.join(root, 'caches/jars-9/dir')])
    })

    it('matches files as well as directories without a trailing slash', () => {
        mk('caches', 'jars-9', 'dir')
        touch('caches/jars-9/file')
        expect(resolvePatternLine(path.join(root, 'caches/jars-*/*')).sort()).toEqual([
            path.join(root, 'caches/jars-9/dir'),
            path.join(root, 'caches/jars-9/file')
        ])
    })

    it('matches a partial wildcard within a segment', () => {
        mk('caches', 'modules-2')
        mk('caches', 'modules-3')
        mk('caches', 'jars-9')
        expect(resolvePatternLine(path.join(root, 'caches/modules-*/')).sort()).toEqual([
            path.join(root, 'caches/modules-2'),
            path.join(root, 'caches/modules-3')
        ])
    })

    it('matches a suffix wildcard, as used for shard patterns', () => {
        mk('caches', '9.6.1', 'transforms', 'aaa1')
        mk('caches', '9.6.1', 'transforms', 'bbb2')
        mk('caches', '9.6.1', 'transforms', 'ccc1')
        expect(resolvePatternLine(path.join(root, 'caches/*/transforms/*1/')).sort()).toEqual([
            path.join(root, 'caches/9.6.1/transforms/aaa1'),
            path.join(root, 'caches/9.6.1/transforms/ccc1')
        ])
    })

    it('matches an extension wildcard', () => {
        touch('caches/9.6.1/generated-gradle-jars/a.jar')
        touch('caches/9.6.1/generated-gradle-jars/b.txt')
        expect(resolvePatternLine(path.join(root, 'caches/*/generated-gradle-jars/*.jar'))).toEqual([
            path.join(root, 'caches/9.6.1/generated-gradle-jars/a.jar')
        ])
    })

    it('resolves a deep pattern with several consecutive wildcards', () => {
        touch('caches/modules-2/files-2.1/g1/m1/1.0/deadbeef/m1.jar')
        touch('caches/modules-2/files-2.1/g2/m2/2.0/cafebabe/m2.jar')
        expect(resolvePatternLine(path.join(root, 'caches/modules-*/files-*/*/*/*/*')).sort()).toEqual([
            path.join(root, 'caches/modules-2/files-2.1/g1/m1/1.0/deadbeef'),
            path.join(root, 'caches/modules-2/files-2.1/g2/m2/2.0/cafebabe')
        ])
    })

    it('handles a literal segment following a wildcard', () => {
        mk('caches', '9.6.1', 'kotlin-dsl', 'accessors', 'aaa')
        mk('caches', '8.10.2', 'kotlin-dsl', 'accessors', 'bbb')
        mk('caches', 'jars-9')
        expect(resolvePatternLine(path.join(root, 'caches/*/kotlin-dsl/accessors/*/')).sort()).toEqual([
            path.join(root, 'caches/8.10.2/kotlin-dsl/accessors/bbb'),
            path.join(root, 'caches/9.6.1/kotlin-dsl/accessors/aaa')
        ])
    })

    it('returns nothing for a pattern whose directories do not exist', () => {
        mk('caches')
        expect(resolvePatternLine(path.join(root, 'caches/does-not-exist-*/*/'))).toEqual([])
    })

    it('resolves a fully literal pattern', () => {
        mk('caches')
        expect(resolvePatternLine(path.join(root, 'caches/'))).toEqual([path.join(root, 'caches')])
    })

    it('returns nothing for a fully literal pattern that does not exist', () => {
        expect(resolvePatternLine(path.join(root, 'nope'))).toEqual([])
    })

    it('does not treat a literal dot in a segment as a regex wildcard', () => {
        mk('caches', '9.6.1', 'groovy-dsl', 'aaa')
        mk('caches', '9x6x1', 'groovy-dsl', 'bbb')
        // '9.6.1' as a literal must not match '9x6x1'.
        expect(resolvePatternLine(path.join(root, 'caches/9.6.1/groovy-dsl/*/'))).toEqual([
            path.join(root, 'caches/9.6.1/groovy-dsl/aaa')
        ])
    })

    it("includes hidden entries, matching the action's glob options", () => {
        mk('caches', 'jars-9', '.hidden')
        mk('caches', 'jars-9', 'plain')
        expect(resolvePatternLine(path.join(root, 'caches/jars-*/*/')).sort()).toEqual([
            path.join(root, 'caches/jars-9/.hidden'),
            path.join(root, 'caches/jars-9/plain')
        ])
    })

    it('follows a symlinked directory', () => {
        const target = mk('real', 'inner')
        mk('caches', 'jars-9')
        fs.symlinkSync(target, path.join(root, 'caches/jars-9/link'), 'dir')
        expect(resolvePatternLine(path.join(root, 'caches/jars-*/*/'))).toEqual([path.join(root, 'caches/jars-9/link')])
    })

    it('omits a broken symlink', () => {
        mk('caches', 'jars-9')
        fs.symlinkSync(path.join(root, 'missing-target'), path.join(root, 'caches/jars-9/broken'), 'dir')
        expect(resolvePatternLine(path.join(root, 'caches/jars-*/*/'))).toEqual([])
    })

    // A directory entry reports the link itself rather than its target, so every case below is one the
    // entry type alone answers wrongly and only a stat on the link can settle.
    it('omits a broken symlink when the pattern also matches files', () => {
        mk('caches', 'jars-9')
        touch('caches/jars-9/real-file')
        fs.symlinkSync(path.join(root, 'missing-target'), path.join(root, 'caches/jars-9/broken'), 'file')
        expect(resolvePatternLine(path.join(root, 'caches/jars-*/*'))).toEqual([
            path.join(root, 'caches/jars-9/real-file')
        ])
    })

    it('excludes a symlink to a file from a directories-only pattern', () => {
        mk('caches', 'jars-9')
        const target = touch('real-file')
        mk('caches', 'jars-9', 'dir')
        fs.symlinkSync(target, path.join(root, 'caches/jars-9/link-to-file'), 'file')
        expect(resolvePatternLine(path.join(root, 'caches/jars-*/*/'))).toEqual([path.join(root, 'caches/jars-9/dir')])
    })

    it('descends through a symlinked directory in an intermediate segment', () => {
        const target = mk('real', 'transforms')
        fs.mkdirSync(path.join(target, 'aaa'))
        mk('caches')
        fs.symlinkSync(path.join(root, 'real'), path.join(root, 'caches/9.6.1'), 'dir')
        expect(resolvePatternLine(path.join(root, 'caches/*/transforms/*/'))).toEqual([
            path.join(root, 'caches/9.6.1/transforms/aaa')
        ])
    })
})

describe('resolveEntryPattern', () => {
    it('unions several newline-separated patterns', () => {
        mk('caches', 'transforms-4', 'aaa')
        mk('caches', '9.6.1', 'transforms', 'bbb')
        const pattern = [
            `${path.join(root, 'caches/transforms-4/*/')}`,
            `${path.join(root, 'caches/*/transforms/*/')}`
        ].join('\n')
        expect(resolveEntryPattern(pattern)).toEqual([
            path.join(root, 'caches/9.6.1/transforms/bbb'),
            path.join(root, 'caches/transforms-4/aaa')
        ])
    })

    it('returns a sorted, de-duplicated list so cache keys are stable', () => {
        mk('caches', 'jars-9', 'b')
        mk('caches', 'jars-9', 'a')
        // The same pattern twice must not double up.
        const line = path.join(root, 'caches/jars-*/*/')
        const found = resolveEntryPattern(`${line}\n${line}`)
        expect(found).toEqual([path.join(root, 'caches/jars-9/a'), path.join(root, 'caches/jars-9/b')])
    })

    it('ignores blank lines', () => {
        mk('caches', 'jars-9', 'a')
        const found = resolveEntryPattern(`\n${path.join(root, 'caches/jars-*/*/')}\n\n`)
        expect(found).toEqual([path.join(root, 'caches/jars-9/a')])
    })
})

// The Windows cases below are why splitPatternRoot takes a path flavour: a drive letter joined onto a
// leading separator produces '\D:\...', a path rooted on the current drive that cannot exist, so every
// absolute pattern resolved to nothing and the action cached nothing at all on Windows runners.
describe('splitPatternRoot', () => {
    it('keeps a Windows drive letter in the root', () => {
        expect(splitPatternRoot('D:\\a\\.gradle\\wrapper\\dists\\*\\*', path.win32)).toEqual({
            root: 'D:\\',
            segments: ['a', '.gradle', 'wrapper', 'dists', '*', '*']
        })
    })

    it('rebuilds a Windows path from its own root and segments', () => {
        const {root, segments} = splitPatternRoot('D:\\a\\.gradle\\caches', path.win32)
        expect(path.win32.join(root, ...segments)).toBe('D:\\a\\.gradle\\caches')
    })

    it('keeps a UNC share in the root', () => {
        expect(splitPatternRoot('\\\\server\\share\\caches\\*', path.win32)).toEqual({
            root: '\\\\server\\share\\',
            segments: ['caches', '*']
        })
    })

    it('splits a posix path at the leading slash', () => {
        expect(splitPatternRoot('/home/runner/.gradle/caches/*', path.posix)).toEqual({
            root: '/',
            segments: ['home', 'runner', '.gradle', 'caches', '*']
        })
    })

    it('reports no root for a relative pattern', () => {
        expect(splitPatternRoot('caches/*/transforms', path.posix)).toEqual({
            root: '',
            segments: ['caches', '*', 'transforms']
        })
    })

    it('reports no segments for a bare root', () => {
        expect(splitPatternRoot('/', path.posix)).toEqual({root: '/', segments: []})
    })
})

// @actions/cache resolves the paths it archives itself. The action registers resolvePathsForCache to
// do that resolution instead, so what it declines matters as much as what it handles: a pattern shape
// it cannot express must fall back to @actions/glob rather than silently resolve to a subset, which
// would quietly shrink what gets cached.
describe('canResolvePatternLine', () => {
    it.each([
        ['a single wildcard segment', '/gradle/caches/*/transforms/*/'],
        ['a suffix wildcard', '/gradle/caches/transforms-4/*4/'],
        ['an extension wildcard', '/gradle/caches/*/generated-gradle-jars/*.jar'],
        ['a fully literal path', '/gradle/caches']
    ])('handles %s', (_name, pattern) => {
        expect(canResolvePatternLine(pattern)).toBe(true)
    })

    it.each([
        ['an exclusion', '!/gradle/caches/modules-2'],
        ['a recursive wildcard', '/gradle/caches/**/transforms'],
        ['a single-character wildcard', '/gradle/caches/jars-?'],
        ['a character class', '/gradle/caches/jars-[0-9]'],
        ['a brace expansion', '/gradle/caches/{modules-2,jars-9}'],
        ['an extglob group', '/gradle/caches/+(modules-2|jars-9)']
    ])('declines %s', (_name, pattern) => {
        expect(canResolvePatternLine(pattern)).toBe(false)
    })
})

describe('resolvePathsForCache', () => {
    it('resolves patterns it fully implements', () => {
        mk('caches', 'jars-9', 'aaa')
        mk('caches', 'jars-9', 'bbb')
        expect(resolvePathsForCache([path.join(root, 'caches/jars-*/*/')])?.sort()).toEqual([
            path.join(root, 'caches/jars-9/aaa'),
            path.join(root, 'caches/jars-9/bbb')
        ])
    })

    it('declines the whole set when any one pattern is unsupported', () => {
        mk('caches', 'jars-9', 'aaa')
        expect(
            resolvePathsForCache([path.join(root, 'caches/jars-*/*/'), `!${path.join(root, 'caches/jars-9')}`])
        ).toBeUndefined()
    })

    it('declines an empty set rather than claiming it resolved to nothing', () => {
        expect(resolvePathsForCache([])).toBeUndefined()
        expect(resolvePathsForCache(['   '])).toBeUndefined()
    })

    it('resolves several patterns together, sorted and de-duplicated', () => {
        mk('caches', 'jars-9', 'aaa')
        mk('caches', 'modules-2', 'bbb')
        expect(
            resolvePathsForCache([path.join(root, 'caches/jars-*/*/'), path.join(root, 'caches/jars-9/*/')])
        ).toEqual([path.join(root, 'caches/jars-9/aaa')])
    })
})

describe('withExplicitPaths', () => {
    const pattern = '/gradle/caches/transforms-4/*a/'
    const paths = ['/gradle/caches/transforms-4/00a', '/gradle/caches/transforms-4/01a']

    it('supplies the registered paths instead of resolving the pattern', async () => {
        await withExplicitPaths([pattern], paths, async () => {
            expect(resolvePathsForCache([pattern])).toEqual(paths)
        })
    })

    it('matches the pattern however it is spaced or split', async () => {
        await withExplicitPaths([`  ${pattern}  `, '', '  '], paths, async () => {
            expect(resolvePathsForCache([pattern])).toEqual(paths)
        })
    })

    it('leaves nothing registered afterwards', async () => {
        await withExplicitPaths([pattern], paths, async () => undefined)
        // The pattern is not under the temporary root, so resolving it for real finds nothing.
        expect(resolvePathsForCache([pattern])).toEqual([])
    })

    it('leaves nothing registered when the action throws', async () => {
        await expect(
            withExplicitPaths([pattern], paths, async () => {
                throw new Error('upload failed')
            })
        ).rejects.toThrow('upload failed')
        expect(resolvePathsForCache([pattern])).toEqual([])
    })

    it('keeps concurrent registrations of different patterns apart', async () => {
        const otherPattern = '/gradle/caches/transforms-4/*b/'
        const otherPaths = ['/gradle/caches/transforms-4/00b']
        await withExplicitPaths([pattern], paths, async () =>
            withExplicitPaths([otherPattern], otherPaths, async () => {
                expect(resolvePathsForCache([pattern])).toEqual(paths)
                expect(resolvePathsForCache([otherPattern])).toEqual(otherPaths)
            })
        )
        expect(resolvePathsForCache([pattern])).toEqual([])
    })

    // Archiving the wrong content would be worse than repeating the work, so a conflicting registration
    // disables the override for both rather than letting either win.
    it('declines to override when the same pattern is registered with different paths', async () => {
        await withExplicitPaths([pattern], paths, async () =>
            withExplicitPaths([pattern], ['/gradle/caches/transforms-4/02a'], async () => {
                expect(resolvePathsForCache([pattern])).toEqual(paths)
            })
        )
        expect(resolvePathsForCache([pattern])).toEqual([])
    })
})

describe('resolveEntryPatternWithFallback', () => {
    it('resolves a supported pattern itself', async () => {
        mk('caches', '8.14', 'cc-keystore')
        expect(await resolveEntryPatternWithFallback(path.join(root, 'caches/*/cc-keystore'))).toEqual([
            path.join(root, 'caches/8.14/cc-keystore')
        ])
    })

    it('falls back to @actions/glob for a pattern it does not implement', async () => {
        mk('caches', '8.14', 'kotlin-dsl', 'scripts')
        const matched = await resolveEntryPatternWithFallback(path.join(root, 'caches/**/scripts'))
        expect(matched).toEqual([path.join(root, 'caches/8.14/kotlin-dsl/scripts')])
    })
})

describe('matchedEntryParents', () => {
    it('names the directory above the first wildcard', () => {
        expect(matchedEntryParents('/gradle/caches/transforms-4/*a/')).toEqual(['/gradle/caches/transforms-4'])
        expect(matchedEntryParents('/gradle/caches/modules-*/files-*/*/*/*/*')).toEqual(['/gradle/caches'])
    })

    it('names one directory per line of the pattern', () => {
        expect(matchedEntryParents('/gradle/caches/transforms-4/*/\n/gradle/caches/*/transforms/*/')).toEqual([
            '/gradle/caches/transforms-4',
            '/gradle/caches'
        ])
    })

    // A fully literal pattern names the match itself -- these are the per-file entries. Creating that path
    // as a directory would put a directory where the file has to go.
    it('names the containing directory of a fully literal pattern', () => {
        expect(matchedEntryParents('/gradle/wrapper/dists/gradle-8.14-bin/abc/gradle-8.14')).toEqual([
            '/gradle/wrapper/dists/gradle-8.14-bin/abc'
        ])
    })
})
