// Drives the action's real save and restore against the local cache service, to answer the question the
// offline benches cannot: does transferring fewer cache entries at once cost anything once the transfer is
// real? Archive creation alone said no, but archive creation is not where the time goes.
//
// Every run also verifies the cycle: the Gradle User Home after restore must hold everything it held
// before saving. A faster cache that loses content is not an improvement.
//
// Built and run by run-harness.sh, which bundles it and starts the server.
import fs from 'fs'
import path from 'path'

import {GradleUserHomeCache} from '../../src/caching/gradle-user-home-cache'
import {CacheListener} from '../../src/caching/cache-reporting'
import {CacheConfig} from '../../src/configuration'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain JavaScript helper, bundled alongside
import {buildFixture, inventory, mutate, totalBytes} from './fixture.mjs'

const flag = (name: string, fallback: string): string =>
    process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback

const template = process.argv[2]
const fanout = flag('fanout', '1,2,4,8,16,48').split(',')
const runs = Number(flag('runs', '1'))
const scenario = flag('scenario', 'fanout')

const gradleUserHome = flag('home', '/tmp/harness-guh')
// Files under 'caches/<version>/scripts' that no extracted entry claims, so they end up in the main entry.
const homeOnly = Number(flag('home-only-mb', '0'))
const serverUrl = process.env['ACTIONS_CACHE_URL']!

const elapsed = async (action: () => Promise<void>): Promise<number> => {
    const started = process.hrtime.bigint()
    await action()
    return Number(process.hrtime.bigint() - started) / 1e6
}

async function serverStats(): Promise<{entries: number; bytes: number}> {
    const response = await fetch(`${serverUrl}_apis/artifactcache/__stats`)
    return (await response.json()) as {entries: number; bytes: number}
}

const resetServer = async (): Promise<void> => {
    await fetch(`${serverUrl}_apis/artifactcache/__reset`)
}

/** The action writes these; they are not part of the Gradle User Home being compared. */
const ACTION_WRITTEN = /^\.setup-gradle[/\\]/

function freshHome(): string[] {
    fs.rmSync(gradleUserHome, {recursive: true, force: true})
    fs.cpSync(template, gradleUserHome, {recursive: true})
    return inventory(gradleUserHome).filter((name: string) => !ACTION_WRITTEN.test(name))
}

function emptyHome(): void {
    fs.rmSync(gradleUserHome, {recursive: true, force: true})
    fs.mkdirSync(path.join(gradleUserHome, '.setup-gradle'), {recursive: true})
}

const cache = (): GradleUserHomeCache => new GradleUserHomeCache('/tmp', gradleUserHome, new CacheConfig())

interface Outcome {
    saveMs: number
    restoreMs: number
    entries: number
    bytes: number
    missing: string[]
    extra: string[]
}

async function cycle(): Promise<Outcome> {
    const before = freshHome()

    const saveMs = await elapsed(async () => cache().save(new CacheListener()))
    const {entries, bytes} = await serverStats()

    emptyHome()
    const restoreMs = await elapsed(async () => cache().restore(new CacheListener()))

    const after = new Set(inventory(gradleUserHome).filter((name: string) => !ACTION_WRITTEN.test(name)))
    const missing = before.filter(name => !after.has(name))
    const extra = [...after].filter(name => !before.includes(name))
    return {saveMs, restoreMs, entries, bytes, missing, extra}
}

const mib = (bytes: number): string => (bytes / 1048576).toFixed(0)

async function main(): Promise<void> {
    if (!fs.existsSync(template)) {
        buildFixture(template, {
            transforms: 12000,
            dependencies: 800,
            buildCache: 1600,
            kotlinDsl: 600,
            homeOnlyMegabytes: homeOnly
        })
    }
    const templatePaths = inventory(template).length
    console.log(
        `fixture: ${templatePaths} paths, ${mib(totalBytes(template))} MB on disk, ` +
            `${homeOnly} files only the main entry holds   scenario: ${scenario}   runs: ${runs}\n`
    )

    if (scenario === 'fanout') {
        console.log('entries at once      save        restore     cache entries   stored    verified')
        for (const concurrency of fanout) {
            process.env['GRADLE_ACTIONS_CACHE_ENTRY_CONCURRENCY'] = concurrency
            const results: Outcome[] = []
            for (let run = 0; run < runs; run++) {
                await resetServer()
                results.push(await cycle())
            }
            const best = (pick: (o: Outcome) => number): number => Math.min(...results.map(pick))
            const last = results[results.length - 1]
            const verified = last.missing.length === 0 ? 'yes' : `NO (${last.missing.length} missing)`
            console.log(
                `${concurrency.padStart(8)}      ` +
                    `${best(o => o.saveMs).toFixed(0).padStart(7)} ms   ` +
                    `${best(o => o.restoreMs).toFixed(0).padStart(7)} ms   ` +
                    `${String(last.entries).padStart(9)}   ` +
                    `${mib(last.bytes).padStart(6)} MB   ${verified}`
            )
            if (last.missing.length > 0) {
                console.log(`           missing, first few: ${last.missing.slice(0, 5).join(', ')}`)
            }
            if (last.extra.length > 0) {
                console.log(`           unexpected extras: ${last.extra.slice(0, 5).join(', ')}`)
            }
        }
    }

    // The job a workflow actually runs most of the time: the cache is warm, and the build added a little.
    // A cold save then a restore then a second save, which is the one that matters.
    if (scenario === 'incremental') {
        console.log(
            'configuration                    ' +
                'second save   uploaded   restore after   entries   verified'
        )
        const configurations: [string, Record<string, string>][] = [
            ['as shipped', {}],
            ['layers off', {GRADLE_ACTIONS_CACHE_LAYERS: 'false'}],
            ['index off', {GRADLE_ACTIONS_CACHE_PARALLEL_RESTORE: 'false'}],
            ['layers and index off (v5 shape)', {
                GRADLE_ACTIONS_CACHE_LAYERS: 'false',
                GRADLE_ACTIONS_CACHE_PARALLEL_RESTORE: 'false'
            }]
        ]

        for (const [label, env] of configurations) {
            for (const [key, value] of Object.entries(env)) process.env[key] = value
            await resetServer()

            // Cold: save everything, then restore it, as the previous job in the workflow would have.
            // Each save is at its own commit, because the Gradle User Home key ends in the commit sha and
            // a cache entry cannot be overwritten: saving twice under one key is a second job re-running
            // the same commit, not the incremental case being measured.
            process.env['GRADLE_BUILD_ACTION_CACHE_KEY_JOB_EXECUTION'] = 'commit-1'
            const before = freshHome()
            await cache().save(new CacheListener())
            const cold = await serverStats()
            emptyHome()
            await cache().restore(new CacheListener())

            // The build adds a little, and the job saves again. This is the save being measured.
            process.env['GRADLE_BUILD_ACTION_CACHE_KEY_JOB_EXECUTION'] = 'commit-2'
            const added = mutate(gradleUserHome, {transforms: 400, dependencies: 20})
            const secondSaveMs = await elapsed(async () => cache().save(new CacheListener()))
            const warm = await serverStats()

            emptyHome()
            const restoreMs = await elapsed(async () => cache().restore(new CacheListener()))
            const after = new Set(inventory(gradleUserHome).filter((name: string) => !ACTION_WRITTEN.test(name)))
            const expected = [...before, ...added]
            const missing = expected.filter(name => !after.has(name))

            for (const key of Object.keys(env)) delete process.env[key]
            console.log(
                `${label.padEnd(32)} ` +
                    `${secondSaveMs.toFixed(0).padStart(8)} ms   ` +
                    `${mib(warm.bytes - cold.bytes).padStart(5)} MB   ` +
                    `${restoreMs.toFixed(0).padStart(10)} ms   ` +
                    `${String(warm.entries).padStart(7)}   ` +
                    `${missing.length === 0 ? 'yes' : `NO (${missing.length} missing)`}`
            )
            if (missing.length > 0) {
                console.log(`      missing, first few: ${missing.slice(0, 5).join(', ')}`)
            }
        }
    }
}

await main()
