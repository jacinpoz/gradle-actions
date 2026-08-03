// Measures the glob cost of sharding against a real Gradle User Home.
//
// The risk in pattern-rewrite sharding is that `@actions/cache` re-globs the pattern it is given, so
// 16 shards could mean 16 tree walks instead of 1. This measures the actual cost of:
//   (a) one glob of the unsharded pattern            -- what v5 does
//   (b) 16 globs, one per shard pattern, serially    -- worst case for sharding
//   (c) 16 shard patterns in a single globber        -- one walk, matching all patterns
//   (d) 1 glob + in-memory partition by suffix       -- what the extractor actually does at extract time
import * as glob from '@actions/glob'
import path from 'path'
import os from 'os'

const GUH = process.argv[2] || path.join(os.homedir(), '.gradle')
const HEX = '0123456789abcdef'.split('')

const shardPattern = (pattern, suffix) =>
    pattern
        .split('\n')
        .map(line => line.replace(/\*(?=[^*]*$)/, `*${suffix}`))
        .join('\n')

const shardSuffixForPath = (p, n) => {
    const name = path.basename(p).toLowerCase()
    const s = name.substring(name.length - n)
    return s.length === n && [...s].every(c => HEX.includes(c)) ? s : undefined
}

const resolve = pattern =>
    pattern
        .split('\n')
        .map(line => (line.endsWith('/') ? `${path.resolve(GUH, line)}/` : path.resolve(GUH, line)))
        .join('\n')

async function timed(label, fn) {
    const t0 = process.hrtime.bigint()
    const result = await fn()
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    console.log(`  ${label.padEnd(46)} ${ms.toFixed(0).padStart(7)} ms   ${result}`)
    return ms
}

const FAMILIES = [
    ['transforms', 'caches/transforms-4/*/\ncaches/*/transforms/*/'],
    ['dependencies', 'caches/modules-*/files-*/*/*/*/*'],
    ['kotlin-dsl', 'caches/*/kotlin-dsl/accessors/*/\ncaches/*/kotlin-dsl/scripts/*/']
]

for (const [name, rawPattern] of FAMILIES) {
    const pattern = resolve(rawPattern)
    console.log(`\n=== ${name} ===`)

    let total = 0
    const a = await timed('(a) single unsharded glob [v5]', async () => {
        const g = await glob.create(pattern, {implicitDescendants: false})
        const files = await g.glob()
        total = files.length
        return `${files.length} paths`
    })

    const b = await timed('(b) 16 shard globs, serial [worst case]', async () => {
        let n = 0
        for (const h of HEX) {
            const g = await glob.create(shardPattern(pattern, h), {implicitDescendants: false})
            n += (await g.glob()).length
        }
        return `${n} paths`
    })

    const c = await timed('(c) 16 shard patterns, one globber', async () => {
        const combined = HEX.map(h => shardPattern(pattern, h)).join('\n')
        const g = await glob.create(combined, {implicitDescendants: false})
        return `${(await g.glob()).length} paths`
    })

    const d = await timed('(d) 1 glob + in-memory partition [impl]', async () => {
        const g = await glob.create(pattern, {implicitDescendants: false})
        const files = await g.glob()
        const shards = new Map()
        let unsharded = 0
        for (const f of files) {
            const s = shardSuffixForPath(f, 1)
            if (s === undefined) {
                unsharded++
                continue
            }
            shards.set(s, (shards.get(s) || 0) + 1)
        }
        const counts = [...shards.values()]
        const min = Math.min(...counts)
        const max = Math.max(...counts)
        const mean = total / 16
        return `${shards.size}/16 shards, min ${min}, max ${max}, skew ${(max / mean).toFixed(2)}x, unsharded ${unsharded}`
    })

    console.log(`  -> (b)/(a) = ${(b / a).toFixed(2)}x   (c)/(a) = ${(c / a).toFixed(2)}x   (d)/(a) = ${(d / a).toFixed(2)}x`)
}
