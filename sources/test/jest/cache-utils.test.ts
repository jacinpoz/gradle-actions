import {describe, expect, it} from '@jest/globals'

import * as cacheUtils from '../../src/caching/cache-utils'

describe('cacheUtils-utils', () => {
    describe('can hash', () => {
        it('a string', async () => {
            const hash = cacheUtils.hashStrings(['foo'])
            expect(hash).toBe('acbd18db4cc2f85cedef654fccc4a4d8')
        })
        it('multiple strings', async () => {
            const hash = cacheUtils.hashStrings(['foo', 'bar', 'baz'])
            expect(hash).toBe('6df23dc03f9b54cc38a0fc1483df6e21')
        })
        it('normalized filenames', async () => {
            const hash = cacheUtils.hashFileNames(['/foo/bar/baz.zip', '../boo.html'])
            expect(hash).toBe('c0b0bc4abd18c6b83fbb5fc35a3be372')
        })
        // The cache key must not depend on the platform that wrote it: a Windows runner and a Linux
        // runner naming the same files have to agree, or neither ever hits the other's cache entry.
        it('windows filenames to the same value as their posix equivalents', async () => {
            const normalized = cacheUtils.normalizeFileNames(['\\foo\\bar\\baz.zip', '..\\boo.html'], '\\')
            expect(normalized).toEqual(['/foo/bar/baz.zip', '../boo.html'])
            expect(cacheUtils.hashStrings(normalized)).toBe('c0b0bc4abd18c6b83fbb5fc35a3be372')
        })
    })

    describe('maps concurrently', () => {
        it('preserving the order of the results', async () => {
            const items = [30, 10, 20, 0]
            const results = await cacheUtils.mapConcurrently(items, 2, async delay => {
                await new Promise(resolve => setTimeout(resolve, delay))
                return delay
            })
            expect(results).toEqual(items)
        })
        it('never exceeding the limit', async () => {
            let inFlight = 0
            let highWaterMark = 0
            await cacheUtils.mapConcurrently([...Array(20).keys()], 3, async () => {
                inFlight++
                highWaterMark = Math.max(highWaterMark, inFlight)
                await new Promise(resolve => setTimeout(resolve, 5))
                inFlight--
                return undefined
            })
            expect(highWaterMark).toBe(3)
        })
        it('with nothing to do', async () => {
            expect(await cacheUtils.mapConcurrently([], 4, async () => 1)).toEqual([])
        })
    })

    describe('bounds the cache entry fan-out', () => {
        it('to the configured override', () => {
            process.env['GRADLE_ACTIONS_CACHE_ENTRY_CONCURRENCY'] = '3'
            try {
                expect(cacheUtils.entryConcurrency()).toBe(3)
            } finally {
                delete process.env['GRADLE_ACTIONS_CACHE_ENTRY_CONCURRENCY']
            }
        })
        it('ignoring an override that is not a positive whole number', () => {
            for (const override of ['0', '-1', 'many', '2.5', '']) {
                process.env['GRADLE_ACTIONS_CACHE_ENTRY_CONCURRENCY'] = override
                expect(cacheUtils.entryConcurrency()).toBeGreaterThanOrEqual(4)
            }
            delete process.env['GRADLE_ACTIONS_CACHE_ENTRY_CONCURRENCY']
        })
        it('to a range that suits a hosted runner by default', () => {
            const concurrency = cacheUtils.entryConcurrency()
            expect(concurrency).toBeGreaterThanOrEqual(4)
            expect(concurrency).toBeLessThanOrEqual(8)
        })
    })

    describe('normalizes file names', () => {
        it('leaving posix names untouched', async () => {
            const fileNames = ['/foo/bar/baz.zip', '../boo.html']
            expect(cacheUtils.normalizeFileNames(fileNames, '/')).toEqual(fileNames)
        })
        it('rewriting every separator in a name, not just the first', async () => {
            expect(cacheUtils.normalizeFileNames(['a\\b\\c\\d'], '\\')).toEqual(['a/b/c/d'])
        })
    })
})
