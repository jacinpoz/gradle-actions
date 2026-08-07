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
