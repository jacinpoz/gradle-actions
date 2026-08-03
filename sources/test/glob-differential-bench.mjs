// Differential check: resolveEntryPattern must return exactly the same set as @actions/glob for every
// cache entry pattern v5 defines, against a real Gradle User Home. Compares the full sorted lists, not
// counts, and reports the speedup.
//
// Run: node --experimental-strip-types test/glob-differential-bench.mjs [gradleUserHome]
import * as glob from '@actions/glob'
import path from 'path'
import os from 'os'
import {resolveEntryPattern} from '../src/caching/cache-glob.ts'

const GUH = process.argv[2] || path.join(os.homedir(), '.gradle')

// Every pattern from GradleHomeEntryExtractor.getExtractedCacheEntryDefinitions, plus the sharded
// variants, plus the configuration-cache pattern shape.
const RAW_PATTERNS = [
    ['generated-gradle-jars', ['caches/*/generated-gradle-jars/*.jar']],
    ['wrapper-zips', ['wrapper/dists/*/*/']],
    ['java-toolchains', ['jdks/*/']],
    ['dependencies', ['caches/modules-*/files-*/*/*/*/*']],
    ['instrumented-jars', ['caches/jars-*/*/']],
    ['kotlin-dsl', ['caches/*/kotlin-dsl/accessors/*/', 'caches/*/kotlin-dsl/scripts/*/']],
    ['groovy-dsl', ['caches/*/groovy-dsl/*/']],
    ['transforms', ['caches/transforms-4/*/', 'caches/*/transforms/*/']],
    // sharded forms
    ['dependencies-shard-a', ['caches/modules-*/files-*/*/*/*/*a']],
    ['transforms-shard-f', ['caches/transforms-4/*f/', 'caches/*/transforms/*f/']],
    ['kotlin-dsl-shard-0', ['caches/*/kotlin-dsl/accessors/*0/', 'caches/*/kotlin-dsl/scripts/*0/']],
    // literal and edge shapes
    ['cc-keystore', ['caches/*/cc-keystore']],
    ['literal-caches', ['caches/']],
    ['nonexistent', ['caches/does-not-exist-*/*/']]
]

const absolute = lines =>
    lines.map(l => (l.endsWith('/') ? `${path.resolve(GUH, l)}/` : path.resolve(GUH, l))).join('\n')

let mismatches = 0
let globTotal = 0
let mineTotal = 0

console.log(`Gradle User Home: ${GUH}\n`)
console.log(`${'pattern'.padEnd(24)} ${'paths'.padStart(8)} ${'glob ms'.padStart(9)} ${'readdir ms'.padStart(11)} ${'speedup'.padStart(8)}  match`)

for (const [name, lines] of RAW_PATTERNS) {
    const pattern = absolute(lines)

    const t0 = process.hrtime.bigint()
    const globber = await glob.create(pattern, {implicitDescendants: false})
    const fromGlob = (await globber.glob()).sort()
    const globMs = Number(process.hrtime.bigint() - t0) / 1e6

    const t1 = process.hrtime.bigint()
    const fromMine = resolveEntryPattern(pattern)
    const mineMs = Number(process.hrtime.bigint() - t1) / 1e6

    globTotal += globMs
    mineTotal += mineMs

    const a = new Set(fromGlob)
    const b = new Set(fromMine)
    const onlyGlob = [...a].filter(x => !b.has(x))
    const onlyMine = [...b].filter(x => !a.has(x))
    const equal = onlyGlob.length === 0 && onlyMine.length === 0

    if (!equal) mismatches++

    console.log(
        `${name.padEnd(24)} ${String(fromGlob.length).padStart(8)} ${globMs.toFixed(0).padStart(9)} ${mineMs
            .toFixed(0)
            .padStart(11)} ${(globMs / Math.max(mineMs, 0.001)).toFixed(1).padStart(7)}x  ${equal ? 'OK' : 'MISMATCH'}`
    )

    if (!equal) {
        console.log(`    only @actions/glob (${onlyGlob.length}): ${onlyGlob.slice(0, 3).join(', ')}`)
        console.log(`    only resolver     (${onlyMine.length}): ${onlyMine.slice(0, 3).join(', ')}`)
    }
}

console.log(
    `\nTOTAL  @actions/glob ${globTotal.toFixed(0)} ms   resolver ${mineTotal.toFixed(0)} ms   ` +
        `speedup ${(globTotal / Math.max(mineTotal, 0.001)).toFixed(1)}x`
)
console.log(mismatches === 0 ? 'All patterns agree exactly.' : `${mismatches} pattern(s) DISAGREE.`)
process.exit(mismatches === 0 ? 0 : 1)
