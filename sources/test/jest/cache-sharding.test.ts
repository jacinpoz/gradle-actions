import {describe, expect, it} from '@jest/globals'

import {
    bundleSizeBytes,
    shardArtifactType,
    shardCountFor,
    shardIndexForPath,
    shardPatternForSuffixes,
    shardSuffixGroups
} from '../../src/caching/gradle-home-extry-extractor'

const GIB = 1024 * 1024 * 1024

describe('shardCountFor', () => {
    // The size is what sharding exists to bound. Splitting a bundle costs a lookup and a download per
    // shard on every restore and three round trips per shard on every save, so the answer is as few as
    // keep one entry from growing unwieldy.
    describe('decides from the size the bundle reached last time', () => {
        it('leaving a bundle whole while it fits in one entry', () => {
            expect(shardCountFor(0, 100000)).toBe(1)
            expect(shardCountFor(GIB, 100000)).toBe(1)
        })
        it('splitting it just enough as it grows', () => {
            expect(shardCountFor(1.5 * GIB, 100000)).toBe(2)
            expect(shardCountFor(3 * GIB, 100000)).toBe(4)
            expect(shardCountFor(7 * GIB, 100000)).toBe(8)
            expect(shardCountFor(12 * GIB, 100000)).toBe(16)
        })
        it('stopping at sixteen, however large it gets', () => {
            expect(shardCountFor(50 * GIB, 100000)).toBe(16)
            expect(shardCountFor(500 * GIB, 100000)).toBe(16)
        })
        it('ignoring the path count once a size is known', () => {
            expect(shardCountFor(4 * GIB, 1)).toBe(4)
        })
    })

    // A bundle's size is only known once a run has saved it. Until then this keeps what the action did
    // before sizes were recorded, so a first run behaves as it always has.
    describe('falls back to the path count when no size is known', () => {
        it('sharding a bundle with enough paths in it', () => {
            expect(shardCountFor(undefined, 512)).toBe(16)
            expect(shardCountFor(undefined, 185685)).toBe(16)
        })
        it('leaving a small one whole', () => {
            expect(shardCountFor(undefined, 511)).toBe(1)
            expect(shardCountFor(undefined, 0)).toBe(1)
        })
    })
})

describe('shardSuffixGroups', () => {
    it('gives every shard the same number of suffixes', () => {
        for (const count of [1, 2, 4, 8, 16]) {
            const groups = shardSuffixGroups(count)
            expect(groups).toHaveLength(count)
            expect(new Set(groups.map(group => group.length))).toEqual(new Set([16 / count]))
            expect(groups.flat().join('')).toBe('0123456789abcdef')
        }
    })
    it("groups contiguously, so a path's shard is its trailing character divided by the shard size", () => {
        expect(shardSuffixGroups(4)).toEqual([
            ['0', '1', '2', '3'],
            ['4', '5', '6', '7'],
            ['8', '9', 'a', 'b'],
            ['c', 'd', 'e', 'f']
        ])
    })
})

describe('shardIndexForPath', () => {
    it('places a path by the trailing character of its name', () => {
        expect(shardIndexForPath('/gradle/caches/transforms-4/abc0', 4)).toBe(0)
        expect(shardIndexForPath('/gradle/caches/transforms-4/abc3', 4)).toBe(0)
        expect(shardIndexForPath('/gradle/caches/transforms-4/abc4', 4)).toBe(1)
        expect(shardIndexForPath('/gradle/caches/transforms-4/abcf', 4)).toBe(3)
    })
    it('is case insensitive, as hex is', () => {
        expect(shardIndexForPath('/gradle/caches/jars-9/ABCF', 4)).toBe(3)
    })
    it('places everything in the one shard when there is only one', () => {
        for (const name of ['abc0', 'abcf', 'abc8']) {
            expect(shardIndexForPath(`/gradle/caches/transforms-4/${name}`, 1)).toBe(0)
        }
    })
    // These stay in the main Gradle User Home entry, which is where they lived before the bundle was
    // extracted at all. 'caches/build-cache-1/*' matches two such files.
    it('places a name that does not end in hex in no shard', () => {
        expect(shardIndexForPath('/gradle/caches/build-cache-1/gc.properties', 16)).toBeUndefined()
        expect(shardIndexForPath('/gradle/caches/build-cache-1/build-cache-1.lock', 16)).toBeUndefined()
        expect(shardIndexForPath('/gradle/caches/9.6.1/kotlin-dsl/scripts/cache.properties', 16)).toBeUndefined()
    })
    it('shards the content-addressed entries of the local build cache', () => {
        expect(shardIndexForPath('/gradle/caches/build-cache-1/006cbc5b15b9804a96d4de94d6e1acc3', 16)).toBe(3)
        expect(shardIndexForPath('/gradle/caches/build-cache-1/fee1e974fb8e7da2610ddf6afb3385b0', 16)).toBe(0)
    })
})

describe('shardPatternForSuffixes', () => {
    // The pattern is what the cache version is derived from, so it has to say exactly which names the
    // entry holds: one line per suffix the shard covers, per line of the bundle's pattern.
    it("constrains the last wildcard of a line to each of the shard's suffixes", () => {
        expect(shardPatternForSuffixes('/gradle/caches/transforms-4/*/', ['0', '1'])).toBe(
            '/gradle/caches/transforms-4/*0/\n/gradle/caches/transforms-4/*1/'
        )
    })
    it('covers every line of a multi-line pattern', () => {
        const pattern = '/gradle/caches/transforms-4/*/\n/gradle/caches/*/transforms/*/'
        expect(shardPatternForSuffixes(pattern, ['a', 'b']).split('\n')).toEqual([
            '/gradle/caches/transforms-4/*a/',
            '/gradle/caches/transforms-4/*b/',
            '/gradle/caches/*/transforms/*a/',
            '/gradle/caches/*/transforms/*b/'
        ])
    })
    it('leaves earlier wildcards alone', () => {
        expect(shardPatternForSuffixes('/gradle/caches/modules-*/files-*/*/*/*/*', ['f'])).toBe(
            '/gradle/caches/modules-*/files-*/*/*/*/*f'
        )
    })
})

describe('shardArtifactType', () => {
    // The shard count is part of the name, so changing it changes the entry's identity: a shard of four is
    // not the same content as a shard of sixteen, and must not be restored as though it were.
    it('names a shard by its count and index', () => {
        expect(shardArtifactType('transforms', 4, 2)).toBe('transforms-4-2')
        expect(shardArtifactType('transforms', 16, 2)).toBe('transforms-16-2')
    })
})

describe('bundleSizeBytes', () => {
    const entry = (artifactType: string, bundle: string | undefined, baseSizeBytes: number | undefined): never =>
        ({artifactType, bundle, baseSizeBytes}) as never

    it('sums the shards of a bundle', () => {
        const entries = [
            entry('transforms-4-0', 'transforms', 100),
            entry('transforms-4-1', 'transforms', 200),
            entry('dependencies-16-0', 'dependencies', 900)
        ]
        expect(bundleSizeBytes(entries, 'transforms')).toBe(300)
        expect(bundleSizeBytes(entries, 'dependencies')).toBe(900)
    })

    it("uses an unsharded bundle's own entry", () => {
        expect(bundleSizeBytes([entry('transforms', undefined, 500)], 'transforms')).toBe(500)
    })

    it('is unknown when the bundle has never been saved', () => {
        expect(bundleSizeBytes([], 'transforms')).toBeUndefined()
    })

    // A size missing from any shard would understate the whole, which would under-shard a bundle that
    // needs splitting. Better to fall back to the path count than to act on a partial total.
    it('is unknown when any shard has no recorded size', () => {
        const entries = [entry('transforms-4-0', 'transforms', 100), entry('transforms-4-1', 'transforms', undefined)]
        expect(bundleSizeBytes(entries, 'transforms')).toBeUndefined()
    })
})
