import {describe, expect, it} from '@jest/globals'

import {CacheEntryListener, CacheListener, generateCachingReport} from '../../src/caching/cache-reporting'

describe('caching report', () => {
    describe('reports not fully restored', () => {
        it('with one requested entry report', async () => {
            const report = new CacheListener()
            report.entry('foo').markRequested('1', ['2'])
            report.entry('bar').markRequested('3').markRestored('4', 500, 1000)
            expect(report.fullyRestored).toBe(false)
        })
    })
    describe('reports fully restored', () => {
        it('when empty', async () => {
            const report = new CacheListener()
            expect(report.fullyRestored).toBe(true)
        })
        it('with empty entry reports', async () => {
            const report = new CacheListener()
            report.entry('foo')
            report.entry('bar')
            expect(report.fullyRestored).toBe(true)
        })
        it('with restored entry report', async () => {
            const report = new CacheListener()
            report.entry('bar').markRequested('3').markRestored('4', 300, 1000)
            expect(report.fullyRestored).toBe(true)
        })
        it('with multiple restored entry reportss', async () => {
            const report = new CacheListener()
            report.entry('foo').markRestored('4', 3300, 111)
            report.entry('bar').markRequested('3').markRestored('4', 333, 1000)
            expect(report.fullyRestored).toBe(true)
        })
    })
    describe('can be stringified and rehydrated', () => {
        it('when empty', async () => {
            const report = new CacheListener()

            const stringRep = report.stringify()
            const reportClone: CacheListener = CacheListener.rehydrate(stringRep)

            expect(reportClone.cacheEntries).toEqual([])

            // Can call methods on rehydrated
            expect(reportClone.entry('foo')).toBeInstanceOf(CacheEntryListener)
        })
        it('with entry reports', async () => {
            const report = new CacheListener()
            report.entry('foo')
            report.entry('bar')
            report.entry('baz')

            const stringRep = report.stringify()
            const reportClone: CacheListener = CacheListener.rehydrate(stringRep)

            expect(reportClone.cacheEntries.length).toBe(3)
            expect(reportClone.cacheEntries[0].entryName).toBe('foo')
            expect(reportClone.cacheEntries[1].entryName).toBe('bar')
            expect(reportClone.cacheEntries[2].entryName).toBe('baz')

            expect(reportClone.entry('foo')).toBe(reportClone.cacheEntries[0])
        })
        it('with rehydrated entry report', async () => {
            const report = new CacheListener()
            const entryReport = report.entry('foo')
            entryReport.markRequested('1', ['2', '3'])
            entryReport.markSaved('4', 100, 1000)

            const stringRep = report.stringify()
            const reportClone: CacheListener = CacheListener.rehydrate(stringRep)
            const entryClone = reportClone.entry('foo')

            expect(entryClone.requestedKey).toBe('1')
            expect(entryClone.requestedRestoreKeys).toEqual(['2', '3'])
            expect(entryClone.savedKey).toBe('4')
            expect(entryClone.savedSize).toBe(100)
            expect(entryClone.savedTime).toBe(1000)
        })
        it('with live entry report', async () => {
            const report = new CacheListener()
            const entryReport = report.entry('foo')
            entryReport.markRequested('1', ['2', '3'])

            const stringRep = report.stringify()
            const reportClone: CacheListener = CacheListener.rehydrate(stringRep)
            const entryClone = reportClone.entry('foo')

            // Check type and call method on rehydrated entry report
            expect(entryClone).toBeInstanceOf(CacheEntryListener)
            entryClone.markSaved('4', 100, 1000)

            expect(entryClone.requestedKey).toBe('1')
            expect(entryClone.requestedRestoreKeys).toEqual(['2', '3'])
            expect(entryClone.savedKey).toBe('4')
        })
    })
})

describe('caching report phases', () => {
    // The entry index describes the cache rather than holding Gradle User Home content, so missing it costs
    // a slower restore, not an incomplete one. Counting it would suppress the configuration-cache restore
    // for a run whose content was in fact fully restored.
    it('does not let a missing metadata entry mean the home was not fully restored', () => {
        const report = new CacheListener()
        report.entry('Gradle User Home').markRequested('1').markRestored('1', 500, 1000)
        report.entry('index').markMetadataOnly().markRequested('2')
        expect(report.fullyRestored).toBe(true)
    })

    it('still reports a missing content entry', () => {
        const report = new CacheListener()
        report.entry('index').markMetadataOnly().markRequested('1').markRestored('1', 10, 20)
        report.entry('Gradle User Home').markRequested('2')
        expect(report.fullyRestored).toBe(false)
    })

    it('accumulates the time spent in each phase', () => {
        const report = new CacheListener()
        report.addPhaseTime('resolve entry patterns', 100)
        report.addPhaseTime('resolve entry patterns', 40)
        report.addPhaseTime('find new paths', 7)
        expect(report.phaseTotals).toEqual({'resolve entry patterns': 140, 'find new paths': 7})
    })

    it('carries phase totals across the main and post action steps', () => {
        const report = new CacheListener()
        report.addPhaseTime('resolve entry patterns', 140)
        report.entry('foo').markKeyTime(12).markDeleteTime(34)

        const rehydrated = CacheListener.rehydrate(report.stringify())
        expect(rehydrated.phaseTotals).toEqual({'resolve entry patterns': 140})
        expect(rehydrated.entry('foo').keyMs).toBe(12)
        expect(rehydrated.entry('foo').deleteMs).toBe(34)
    })

    // State written by an earlier version of the action has no phase totals at all.
    it('rehydrates state that predates phase timings', () => {
        const rehydrated = CacheListener.rehydrate('{"cacheEntries":[],"cacheReadOnly":false}')
        expect(rehydrated.phaseTotals).toEqual({})
        rehydrated.addPhaseTime('resolve entry patterns', 5)
        expect(rehydrated.phaseTotals).toEqual({'resolve entry patterns': 5})
    })

    it('reports the phases it timed, and only those', () => {
        const report = new CacheListener()
        report.addPhaseTime('resolve entry patterns', 140)
        report.entry('foo').markDeleteTime(34)

        const rendered = generateCachingReport(report)
        expect(rendered).toContain('<tr><td>resolve entry patterns</td><td>140</td></tr>')
        expect(rendered).toContain('<tr><td>delete extracted content</td><td>34</td></tr>')
        expect(rendered).not.toContain('hash cache keys')
    })

    it('reports no phase table for a job that ran none of them', () => {
        expect(generateCachingReport(new CacheListener())).not.toContain('Action Phase')
    })
})
