import {beforeEach, describe, expect, it, jest} from '@jest/globals'

import fs from 'fs'
import os from 'os'
import path from 'path'

import {resolvePathsForCache} from '../../src/caching/cache-glob'

/**
 * Drives a full save/restore cycle of an extracted cache entry against an in-memory stand-in for the
 * GitHub Actions cache, to cover what the policy tests in 'cache-layers.test.ts' cannot: that a delta is
 * saved holding only the new paths, that the chain restores in order, and that it is collapsed when full.
 *
 * The stand-in reproduces the two properties the design leans on. It resolves the paths to archive through
 * the action's own resolver, which is how a layer stores a subset of what its pattern matches, and it
 * restores each path with the modification time it had when it was saved, which is how `tar` behaves and
 * is what distinguishes restored content from content the build created.
 */
interface ArchivedPath {
    file: string
    mtimeMs: number
}

const archives = new Map<string, ArchivedPath[]>()
const saved: {key: string; files: string[]}[] = []

jest.unstable_mockModule('@actions/cache', () => ({
    isFeatureAvailable: () => true,
    setPathResolver: () => undefined,
    saveCache: async (patterns: string[], key: string) => {
        const files = resolvePathsForCache(patterns) ?? []
        archives.set(
            key,
            files.map(file => ({file, mtimeMs: fs.statSync(file).mtimeMs}))
        )
        saved.push({key, files})
        return {key, size: files.length}
    },
    restoreCache: async (_patterns: string[], key: string) => {
        const archived = archives.get(key)
        if (!archived) {
            return undefined
        }
        for (const {file, mtimeMs} of archived) {
            fs.mkdirSync(file, {recursive: true})
            fs.writeFileSync(path.join(file, 'marker'), key)
            fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
        }
        return {key, size: archived.length}
    },
    ReserveCacheError: class ReserveCacheError extends Error {},
    ValidationError: class ValidationError extends Error {},
    CacheWriteDeniedError: class CacheWriteDeniedError extends Error {}
}))

const {GradleHomeEntryExtractor} = await import('../../src/caching/gradle-home-extry-extractor')
const {CacheListener} = await import('../../src/caching/cache-reporting')
const {CacheConfig} = await import('../../src/configuration')

let gradleUserHome: string

/** Names the transform directories that are currently in the Gradle User Home. */
const transformsPresent = (): string[] =>
    fs.existsSync(path.join(gradleUserHome, 'caches/transforms-4'))
        ? fs
              .readdirSync(path.join(gradleUserHome, 'caches/transforms-4'))
              .filter(name => name !== 'marker')
              .sort()
        : []

/**
 * Adds transform directories. `aged` backdates them, standing in for content that a build wrote in an
 * earlier job: the whole of one of these tests runs inside a few milliseconds, where a real job leaves
 * minutes between restoring an entry and saving it again.
 */
function addTransforms(names: string[], {aged = false}: {aged?: boolean} = {}): void {
    const anHourAgo = new Date(Date.now() - 3600_000)
    for (const name of names) {
        const dir = path.join(gradleUserHome, 'caches/transforms-4', name)
        fs.mkdirSync(dir, {recursive: true})
        fs.writeFileSync(path.join(dir, 'transformed.jar'), name)
        if (aged) {
            fs.utimesSync(dir, anHourAgo, anHourAgo)
        }
    }
}

/**
 * Backdates every transform directory, standing in for the time that passes between one job saving an entry
 * and the next job restoring it. Without it, content this test added moments ago still counts as new.
 */
function ageAllTransforms(): void {
    const anHourAgo = new Date(Date.now() - 3600_000)
    const root = path.join(gradleUserHome, 'caches/transforms-4')
    for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
        fs.utimesSync(path.join(root, name), anHourAgo, anHourAgo)
    }
}

const extractor = (): InstanceType<typeof GradleHomeEntryExtractor> =>
    new GradleHomeEntryExtractor(gradleUserHome, new CacheConfig())

const metadata = (): {entries: {artifactType: string; layers?: string[]; pathCount?: number}[]} =>
    JSON.parse(fs.readFileSync(path.join(gradleUserHome, '.setup-gradle/gradle-home-entry-metadata.json'), 'utf-8'))

const transformsEntry = (): {artifactType: string; layers?: string[]; pathCount?: number} => {
    const entry = metadata().entries.find(x => x.artifactType === 'transforms')
    expect(entry).toBeDefined()
    return entry!
}

/** The paths of the most recent save, relative to the Gradle User Home. */
const lastSavedNames = (): string[] => saved[saved.length - 1].files.map(file => path.basename(file)).sort()

beforeEach(() => {
    gradleUserHome = fs.mkdtempSync(path.join(os.tmpdir(), 'layer-cycle-'))
    fs.mkdirSync(path.join(gradleUserHome, '.setup-gradle'), {recursive: true})
    archives.clear()
    saved.length = 0
    delete process.env['GRADLE_ACTIONS_CACHE_LAYERS']
})

// Fewer than the sharding threshold, so 'transforms' stays a single bundle entry and the layer behaviour
// is not entangled with which shard a directory lands in. 'cache-sharding.test.ts' covers that separately.
const INITIAL = ['0a1b2c3d', '1a2b3c4d', '2a3b4c5d', '3a4b5c6d', '4a5b6c7d']

describe('an extracted entry over successive jobs', () => {
    it('saves the whole entry when there is nothing to build on', async () => {
        addTransforms(INITIAL, {aged: true})
        await extractor().extract(new CacheListener())

        expect(lastSavedNames()).toEqual([...INITIAL].sort())
        expect(transformsEntry().layers).toHaveLength(1)
        expect(transformsEntry().pathCount).toBe(INITIAL.length)
        // Extraction takes the content out of the Gradle User Home so it is not stored there a second time.
        expect(transformsPresent()).toEqual([])
    })

    it('saves only what the build added, as a layer on what was restored', async () => {
        addTransforms(INITIAL, {aged: true})
        await extractor().extract(new CacheListener())
        const baseLayers = transformsEntry().layers!

        await extractor().restore(new CacheListener())
        expect(transformsPresent()).toEqual([...INITIAL].sort())

        addTransforms(['9f8e7d6c'])
        await extractor().extract(new CacheListener())

        expect(lastSavedNames()).toEqual(['9f8e7d6c'])
        expect(transformsEntry().layers).toEqual([...baseLayers, expect.any(String)])
        expect(transformsEntry().pathCount).toBe(INITIAL.length + 1)
    })

    it('restores every layer of the chain', async () => {
        addTransforms(INITIAL, {aged: true})
        await extractor().extract(new CacheListener())
        await extractor().restore(new CacheListener())
        addTransforms(['9f8e7d6c'])
        await extractor().extract(new CacheListener())

        await extractor().restore(new CacheListener())
        expect(transformsPresent()).toEqual([...INITIAL, '9f8e7d6c'].sort())
    })

    it('saves nothing at all when the content has not changed', async () => {
        addTransforms(INITIAL, {aged: true})
        await extractor().extract(new CacheListener())
        await extractor().restore(new CacheListener())

        const savesBefore = saved.length
        await extractor().extract(new CacheListener())
        expect(saved.length).toBe(savesBefore)
    })

    // A layer can only add paths, so the chain has to be collapsed rather than extended once the content
    // it restored is no longer all there.
    it('rewrites the whole entry when content has been pruned', async () => {
        addTransforms(INITIAL, {aged: true})
        await extractor().extract(new CacheListener())
        await extractor().restore(new CacheListener())

        fs.rmSync(path.join(gradleUserHome, 'caches/transforms-4', INITIAL[0]), {recursive: true})
        await extractor().extract(new CacheListener())

        expect(lastSavedNames()).toEqual([...INITIAL.slice(1)].sort())
        expect(transformsEntry().layers).toHaveLength(1)
    })

    // A prune is recognised by the entry holding fewer paths than it restored, so one that the build's own
    // additions make up for is not recognised at all. The pruned path then comes back with the base on the
    // next restore: wasteful, but not wrong, and cleanup prunes it again. Collapsing the chain on any prune
    // at all would instead give up layering entirely on every job that runs cleanup.
    it('keeps layering when a prune is offset by what the build added', async () => {
        addTransforms(INITIAL, {aged: true})
        await extractor().extract(new CacheListener())
        await extractor().restore(new CacheListener())

        fs.rmSync(path.join(gradleUserHome, 'caches/transforms-4', INITIAL[0]), {recursive: true})
        addTransforms(['9f8e7d6c'])
        await extractor().extract(new CacheListener())

        expect(lastSavedNames()).toEqual(['9f8e7d6c'])
        expect(transformsEntry().layers).toHaveLength(2)

        await extractor().restore(new CacheListener())
        expect(transformsPresent()).toEqual([...INITIAL, '9f8e7d6c'].sort())
    })

    it('collapses the chain once it is full', async () => {
        addTransforms(INITIAL, {aged: true})
        await extractor().extract(new CacheListener())

        // Four layers is the limit, so the fourth job to add something writes a fresh base.
        const added = ['9f8e7d6c', '8e7d6c5b', '7d6c5b4a', '6c5b4a39']
        const layerCounts: number[] = []
        for (const name of added) {
            await extractor().restore(new CacheListener())
            ageAllTransforms() // everything restored belongs to an earlier job
            addTransforms([name])
            await extractor().extract(new CacheListener())
            layerCounts.push(transformsEntry().layers!.length)
        }

        expect(layerCounts).toEqual([2, 3, 4, 1])
        // The collapsing save holds everything, so the chain that replaces it stands on its own.
        expect(lastSavedNames()).toEqual([...INITIAL, ...added].sort())

        await extractor().restore(new CacheListener())
        expect(transformsPresent()).toEqual([...INITIAL, ...added].sort())
    })

    // The 'transforms' entry names both 'caches/transforms-4' and 'caches/<version>/transforms', and a
    // Gradle version uses one of them. Those parents are created before restoring so that concurrently
    // extracting entries do not race to create one, which must not leave behind a directory that no
    // version of Gradle asked for.
    it('leaves behind no directory that nothing restored into', async () => {
        const versioned = path.join(gradleUserHome, 'caches/9.6.1/transforms')
        for (const name of INITIAL) {
            fs.mkdirSync(path.join(versioned, name), {recursive: true})
            fs.writeFileSync(path.join(versioned, name, 'transformed.jar'), name)
        }
        await extractor().extract(new CacheListener())
        fs.rmSync(path.join(gradleUserHome, 'caches'), {recursive: true, force: true})

        await extractor().restore(new CacheListener())

        expect(fs.readdirSync(versioned).sort()).toEqual([...INITIAL].sort())
        expect(fs.existsSync(path.join(gradleUserHome, 'caches/transforms-4'))).toBe(false)
    })

    // A cold cache knows nothing about how large a bundle is, so it splits a big one sixteen ways. Once a
    // run has reported the sizes, the count is chosen from them -- here they are tiny, so the bundle
    // becomes one entry. The run that changes the count saves those bundles in full once.
    it('settles on a shard count once it knows how large the bundle is', async () => {
        // The trailing character decides the shard, so these have to vary in it -- names that all end the
        // same way would land in one shard however many there are.
        const many = Array.from({length: 600}, (_, i) => i.toString(16).padStart(4, '0'))
        addTransforms(many, {aged: true})

        await extractor().extract(new CacheListener())
        const shardedTypes = metadata().entries.filter(e => e.artifactType.startsWith('transforms-'))
        expect(shardedTypes.length).toBeGreaterThan(1)
        expect(shardedTypes.every(e => e.artifactType.startsWith('transforms-16-'))).toBe(true)

        await extractor().restore(new CacheListener())
        expect(transformsPresent()).toEqual([...many].sort())

        ageAllTransforms()
        await extractor().extract(new CacheListener())
        const settled = metadata().entries.filter(e => e.artifactType.startsWith('transforms'))
        expect(settled.map(e => e.artifactType)).toEqual(['transforms'])

        await extractor().restore(new CacheListener())
        expect(transformsPresent()).toEqual([...many].sort())
    })

    it('saves the whole entry every time when layering is turned off', async () => {
        process.env['GRADLE_ACTIONS_CACHE_LAYERS'] = 'false'
        addTransforms(INITIAL, {aged: true})
        await extractor().extract(new CacheListener())
        await extractor().restore(new CacheListener())

        addTransforms(['9f8e7d6c'])
        await extractor().extract(new CacheListener())

        expect(lastSavedNames()).toEqual([...INITIAL, '9f8e7d6c'].sort())
        expect(transformsEntry().layers).toHaveLength(1)
    })
})
