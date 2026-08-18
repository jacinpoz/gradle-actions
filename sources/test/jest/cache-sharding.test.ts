import {
    ExtractedCacheEntryDefinition,
    hexShardSuffixes,
    shardPattern,
    shardSuffixForPath
} from '../../src/caching/gradle-home-extry-extractor'

describe('hexShardSuffixes', () => {
    it('enumerates 16 shards for a single character', () => {
        expect(hexShardSuffixes(1)).toEqual([
            '0',
            '1',
            '2',
            '3',
            '4',
            '5',
            '6',
            '7',
            '8',
            '9',
            'a',
            'b',
            'c',
            'd',
            'e',
            'f'
        ])
    })

    it('enumerates 256 shards for two characters', () => {
        const prefixes = hexShardSuffixes(2)
        expect(prefixes.length).toBe(256)
        expect(prefixes[0]).toBe('00')
        expect(prefixes[255]).toBe('ff')
        expect(new Set(prefixes).size).toBe(256)
    })

    it('is a no-op for zero length', () => {
        expect(hexShardSuffixes(0)).toEqual([''])
    })
})

describe('shardPattern', () => {
    it('constrains the final segment of a dependencies pattern', () => {
        expect(shardPattern('caches/modules-*/files-*/*/*/*/*', 'a')).toBe('caches/modules-*/files-*/*/*/*/*a')
    })

    it('constrains the final segment when the pattern ends with a directory separator', () => {
        expect(shardPattern('caches/*/transforms/*/', '3')).toBe('caches/*/transforms/*3/')
    })

    it('constrains every line of a multi-line pattern', () => {
        expect(shardPattern('caches/transforms-4/*/\ncaches/*/transforms/*/', 'f')).toBe(
            'caches/transforms-4/*f/\ncaches/*/transforms/*f/'
        )
    })

    it('leaves earlier wildcards untouched', () => {
        // Only the last '*' is narrowed; the intervening group/module/version wildcards must survive.
        const sharded = shardPattern('caches/modules-*/files-*/*/*/*/*', '0')
        expect(sharded.split('*').length - 1).toBe(6)
    })

    it('produces distinct patterns for every shard', () => {
        const patterns = hexShardSuffixes(1).map(p => shardPattern('caches/*/transforms/*/', p))
        expect(new Set(patterns).size).toBe(16)
    })
})

describe('shardSuffixForPath', () => {
    it('shards an artifact sha1 directory on its last character', () => {
        expect(
            shardSuffixForPath(
                '/home/runner/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-gradle-plugin-api/2.1.21/f176c87b4bb3131b908dc4cdb5460082c06121c0',
                1
            )
        ).toBe('0')
    })

    it('shards a transform hash directory', () => {
        expect(
            shardSuffixForPath('/home/runner/.gradle/caches/9.6.1/transforms/000015e2ad22c846b87c2c4a53e11951', 1)
        ).toBe('1')
    })

    it('supports multi-character prefixes', () => {
        expect(shardSuffixForPath('/x/000015e2ad22c846b87c2c4a53e11951', 2)).toBe('51')
    })

    it('returns undefined for names that are not hex, so they stay in the main entry', () => {
        // Instrumented jars are named 'o_<hash>' in some Gradle versions.
        expect(shardSuffixForPath('/home/runner/.gradle/caches/jars-9/some_name_ending_in_z', 1)).toBeUndefined()
    })

    it('is case insensitive', () => {
        expect(shardSuffixForPath('/x/0123ABCDEF', 1)).toBe('f')
    })

    it('assigns every hex-named path to exactly one shard', () => {
        const names = ['abc0', 'abc9', 'abca', 'abcf', 'def5']
        const assigned = names.map(n => shardSuffixForPath(`/x/${n}`, 1))
        expect(assigned).toEqual(['0', '9', 'a', 'f', '5'])
    })

    it('distributes evenly over sha1 names whose leading zeros Gradle has stripped', () => {
        // Gradle renders the modules-2 artifact sha1 numerically, dropping leading zeros, so names are
        // sometimes shorter than 40 characters and never begin with '0'. Measured on a real cache:
        // 433/7755 names were 39 chars, 29 were 38, 1 was 37. Sharding on the leading character would
        // leave shard '0' permanently empty and overload the rest; the trailing character is unaffected.
        const stripped = ['f6fd05a8e7a74fbba7b88b06c1e6d300e5e8fde', '8e7cc9ec98823ea809a5102bfa565f8e9e24910']
        for (const name of stripped) {
            expect(name.length).toBeLessThan(40)
            expect(name.startsWith('0')).toBe(false)
            // Still shards cleanly, because the suffix is untouched by the stripping.
            expect(shardSuffixForPath(`/x/${name}`, 1)).toBe(name.slice(-1))
        }
    })

    it('is stable: membership depends only on the directory name', () => {
        // The same hash under a different group/module/version must land in the same shard.
        const a = shardSuffixForPath('/x/caches/modules-2/files-2.1/g1/m1/1.0/deadbeef', 1)
        const b = shardSuffixForPath('/x/caches/modules-2/files-2.1/g2/m2/9.9/deadbeef', 1)
        expect(a).toBe(b)
    })
})

describe('shouldShard', () => {
    const bundle = (suffixLength: number): ExtractedCacheEntryDefinition =>
        new ExtractedCacheEntryDefinition('transforms', '/gradle/caches/transforms-4/*/', true).withHexShards(
            suffixLength
        )

    it('never shards a bundle that was not annotated for it', () => {
        const unsharded = new ExtractedCacheEntryDefinition('groovy-dsl', '/gradle/caches/*/groovy-dsl/*/', true)
        expect(unsharded.shouldShard(100000)).toBe(false)
    })

    // Sixteen entries each holding a handful of paths cost sixteen reservations, uploads and finalizations
    // to save what one entry would, and there is little blast radius left to reduce.
    it('leaves a small bundle whole', () => {
        expect(bundle(1).shouldShard(0)).toBe(false)
        expect(bundle(1).shouldShard(511)).toBe(false)
    })

    it('shards a bundle big enough for every shard to be worth an entry', () => {
        expect(bundle(1).shouldShard(512)).toBe(true)
        expect(bundle(1).shouldShard(185685)).toBe(true)
    })

    it('scales the threshold with the number of shards', () => {
        expect(bundle(2).shouldShard(512)).toBe(false)
        expect(bundle(2).shouldShard(8192)).toBe(true)
    })
})

describe('the local build cache', () => {
    // 'caches/build-cache-1/*' matches the cache entries, which are named by content hash, alongside two
    // files that must stay in the Gradle User Home. Only paths ending in a hex character belong to a shard,
    // so those two are left where they are -- which is what is wanted for a lock file in particular.
    it('shards its content-addressed entries', () => {
        expect(shardSuffixForPath('/gradle/caches/build-cache-1/006cbc5b15b9804a96d4de94d6e1acc3', 1)).toBe('3')
        expect(shardSuffixForPath('/gradle/caches/build-cache-1/fee1e974fb8e7da2610ddf6afb3385b0', 1)).toBe('0')
    })

    it('leaves its bookkeeping files out of every shard', () => {
        expect(shardSuffixForPath('/gradle/caches/build-cache-1/gc.properties', 1)).toBeUndefined()
        expect(shardSuffixForPath('/gradle/caches/build-cache-1/build-cache-1.lock', 1)).toBeUndefined()
    })
})
