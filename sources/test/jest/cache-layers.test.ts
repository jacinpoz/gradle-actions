import {describe, expect, it} from '@jest/globals'

import fs from 'fs'
import os from 'os'
import path from 'path'

import {
    canExtendLayers,
    isDeltaWorthLayering,
    layerEntryName,
    layersOf,
    modifiedAfter
} from '../../src/caching/gradle-home-extry-extractor'

describe('layer chains', () => {
    describe('reads the chain from an entry', () => {
        it('as the recorded layers', () => {
            expect(layersOf({cacheKey: 'newest', layers: ['base', 'delta']})).toEqual(['base', 'delta'])
        })
        // Metadata written before layering existed records only the key, which held the whole content.
        // It has to read as a single-layer chain, or an upgrade would silently stop restoring every
        // extracted entry until each one was written again.
        it('as a single layer when only a key was recorded', () => {
            expect(layersOf({cacheKey: 'whole-thing'})).toEqual(['whole-thing'])
        })
        it('as nothing when neither was recorded', () => {
            expect(layersOf({})).toEqual([])
            expect(layersOf({layers: []})).toEqual([])
        })
    })

    describe('names layers for the report', () => {
        it('leaving the first layer under the entry name', () => {
            expect(layerEntryName('/home/.gradle/caches/transforms-4/*a/', 0)).toBe(
                '/home/.gradle/caches/transforms-4/*a/'
            )
        })
        it('distinguishing later layers', () => {
            expect(layerEntryName('pattern', 1)).toBe('pattern [layer 2]')
            expect(layerEntryName('pattern', 3)).toBe('pattern [layer 4]')
        })
    })

    describe('decides whether a chain can be extended', () => {
        it('not when nothing was restored', () => {
            expect(canExtendLayers(100, undefined, 0)).toBe(false)
        })
        it('not when the entry has no layers to build on', () => {
            expect(canExtendLayers(100, 100, 0)).toBe(false)
        })
        it('when the chain is short and the content is intact', () => {
            expect(canExtendLayers(100, 100, 1)).toBe(true)
            expect(canExtendLayers(120, 100, 3)).toBe(true)
        })
        it('not when the chain is already at its limit', () => {
            expect(canExtendLayers(100, 100, 4)).toBe(false)
        })
        // Cache cleanup prunes unused content before saving. A layer can only add paths, so a chain would
        // keep restoring what was pruned -- tolerable for a few files, not for a real clear-out.
        it('tolerating a small prune', () => {
            expect(canExtendLayers(95, 100, 1)).toBe(true)
        })
        it('not when much of the restored content was pruned', () => {
            expect(canExtendLayers(50, 100, 1)).toBe(false)
            expect(canExtendLayers(89, 100, 1)).toBe(false)
        })
    })

    describe('decides whether a delta is worth a layer', () => {
        // An empty delta means paths went away without enough of them going to look like a prune. A layer
        // cannot express a removal, so the entry has to be written out in full.
        it('not when nothing is new', () => {
            expect(isDeltaWorthLayering(0, 100)).toBe(false)
        })
        it('when the delta is a small part of the entry', () => {
            expect(isDeltaWorthLayering(1, 100)).toBe(true)
            expect(isDeltaWorthLayering(25, 100)).toBe(true)
        })
        it('not when the delta approaches the size of a fresh base', () => {
            expect(isDeltaWorthLayering(26, 100)).toBe(false)
            expect(isDeltaWorthLayering(100, 100)).toBe(false)
        })
    })

    describe('classifies paths by modification time', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-layers-test-'))
        const restoredAt = Date.now()

        // 'tar' restores the modification time recorded in the archive, so restored content keeps the time
        // it had when it was saved. This is what stands in for it.
        const restored = path.join(tmpDir, 'restored')
        fs.mkdirSync(restored)
        fs.utimesSync(restored, new Date(restoredAt - 60_000), new Date(restoredAt - 60_000))

        const created = path.join(tmpDir, 'created')
        fs.mkdirSync(created)
        fs.utimesSync(created, new Date(restoredAt + 60_000), new Date(restoredAt + 60_000))

        it('treating content written after the restore as new', () => {
            expect(modifiedAfter(created, restoredAt)).toBe(true)
        })
        it('treating restored content as unchanged', () => {
            expect(modifiedAfter(restored, restoredAt)).toBe(false)
        })
        // Erring towards saving: a path that vanished mid-run is better re-saved than dropped from the
        // entry that is supposed to hold it.
        it('treating a path that no longer exists as new', () => {
            expect(modifiedAfter(path.join(tmpDir, 'gone'), restoredAt)).toBe(true)
        })
    })
})
