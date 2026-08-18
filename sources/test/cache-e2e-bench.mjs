// End-to-end bench of the save path for the extracted cache entries, with no network.
//
// The per-entry restore and save times in the job summary are dominated by transfer, which hides the
// work the action does itself. This measures that work against a real Gradle User Home, phase by phase,
// and then measures archive creation at a range of zstd levels, which is the one compression knob that
// can be set without patching '@actions/cache' (verified: 'zstdmt' ignores ZSTD_NBTHREADS because its
// implied -T0 takes precedence, but it does honour ZSTD_CLEVEL).
//
// Read-only: it resolves, hashes and archives, and never deletes anything from the Gradle User Home.
//
// Run: node --experimental-strip-types test/cache-e2e-bench.mjs [gradleUserHome] [--levels=1,3,6] [--entry=transforms]
import {execFile, execFileSync} from 'child_process'
import {promisify} from 'util'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import {resolveEntryPattern} from '../src/caching/cache-glob.ts'

// Inlined rather than imported: 'gradle-home-extry-extractor.ts' and 'cache-utils.ts' import their
// siblings without a file extension, which the bundler resolves but Node's ESM loader does not. Kept
// byte-identical in behaviour to the originals -- 'cache-sharding.test.ts' is what pins those.
const HEX_DIGITS = '0123456789abcdef'

const shardSuffixForPath = (filePath, suffixLength) => {
    const name = path.basename(filePath).toLowerCase()
    const suffix = name.substring(name.length - suffixLength)
    return suffix.length === suffixLength && [...suffix].every(c => HEX_DIGITS.includes(c)) ? suffix : undefined
}

const shardPattern = (pattern, suffix) =>
    pattern
        .split('\n')
        .map(line => line.replace(/\*(?=[^*]*$)/, `*${suffix}`))
        .join('\n')

const hashFileNames = fileNames => {
    const hash = crypto.createHash('md5')
    for (const name of path.sep === '/' ? fileNames : fileNames.map(x => x.split(path.sep).join('/'))) {
        hash.update(name)
    }
    return hash.digest('hex')
}

const args = process.argv.slice(2)
const GUH = args.find(a => !a.startsWith('--')) || path.join(os.homedir(), '.gradle')
const flag = name => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1]
const LEVELS = (flag('levels') ?? '1,3,6').split(',').map(Number)
const ENTRY_FILTER = flag('entry')
// Each level is measured REPS times and the fastest run reported. Without a discarded warm-up pass the
// first level measured pays for reading the files off disk, which on a multi-gigabyte shard is most of
// the time and made level 1 look several times slower than level 3.
const REPS = Number(flag('reps') ?? 2)
// '--fanout=1,4,8,48' switches to measuring how long it takes to archive EVERY shard of the selected
// entries at each degree of concurrency, which is what the action's unbounded Promise.all does today.
const FANOUT = flag('fanout')?.split(',').map(Number)

// Mirrors GradleHomeEntryExtractor.getExtractedCacheEntryDefinitions.
const DEFINITIONS = [
    ['generated-gradle-jars', ['caches/*/generated-gradle-jars/*.jar'], 0],
    ['wrapper-zips', ['wrapper/dists/*/*/'], 0],
    ['java-toolchains', ['jdks/*/'], 0],
    ['dependencies', ['caches/modules-*/files-*/*/*/*/*'], 1],
    ['instrumented-jars', ['caches/jars-*/*/'], 0],
    ['kotlin-dsl', ['caches/*/kotlin-dsl/accessors/*/', 'caches/*/kotlin-dsl/scripts/*/'], 1],
    ['groovy-dsl', ['caches/*/groovy-dsl/*/'], 0],
    ['transforms', ['caches/transforms-4/*/', 'caches/*/transforms/*/'], 1],
    // Candidate: today this rides along inside the always-re-uploaded main entry.
    ['build-cache', ['caches/build-cache-1/*'], 1]
]

const elapsedMs = t0 => Number(process.hrtime.bigint() - t0) / 1e6
function timed(fn) {
    const t0 = process.hrtime.bigint()
    const result = fn()
    return {result, ms: elapsedMs(t0)}
}

const absolute = patterns =>
    patterns.map(p => (p.endsWith('/') ? `${path.resolve(GUH, p)}/` : path.resolve(GUH, p))).join('\n')

const relative = file => (file.startsWith(GUH + path.sep) ? file.slice(GUH.length + 1) : path.relative(GUH, file))

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-e2e-bench-'))
const mib = bytes => (bytes / (1024 * 1024)).toFixed(1)

const execFileAsync = promisify(execFile)

/** Archives the given paths concurrently, as one of `limit` archives in flight. */
async function archiveAll(shards, limit, level) {
    let next = 0
    const worker = async id => {
        for (let index = next++; index < shards.length; index = next++) {
            const manifest = path.join(tmpDir, `manifest-${id}.txt`)
            const out = path.join(tmpDir, `cache-${id}.tzst`)
            fs.writeFileSync(manifest, shards[index].map(relative).join('\n'))
            await execFileAsync(
                'tar',
                [
                    '--posix', '-cf', out, '--exclude', out, '-P', '-C', GUH,
                    '--files-from', manifest, '--use-compress-program', 'zstdmt'
                ],
                {env: {...process.env, ZSTD_CLEVEL: `${level}`}}
            )
            fs.rmSync(out, {force: true})
        }
    }
    const t0 = process.hrtime.bigint()
    await Promise.all(Array.from({length: Math.min(limit, shards.length)}, (_, id) => worker(id)))
    return elapsedMs(t0)
}

/** Archives the given paths exactly as '@actions/cache' does, and reports time and size. */
function archive(files, level) {
    const manifest = path.join(tmpDir, 'manifest.txt')
    const out = path.join(tmpDir, 'cache.tzst')
    fs.writeFileSync(manifest, files.map(relative).join('\n'))
    const t0 = process.hrtime.bigint()
    execFileSync(
        'tar',
        [
            '--posix', '-cf', out, '--exclude', out, '-P', '-C', GUH,
            '--files-from', manifest, '--use-compress-program', 'zstdmt'
        ],
        {env: {...process.env, ZSTD_CLEVEL: `${level}`}, stdio: ['ignore', 'ignore', 'inherit']}
    )
    const ms = elapsedMs(t0)
    const size = fs.statSync(out).size
    fs.rmSync(out)
    return {ms, size}
}

console.log(`Gradle User Home: ${GUH}`)
console.log(`zstd levels: ${LEVELS.join(', ')}   (cores: ${os.cpus().length})\n`)

const totals = {resolve: 0, partition: 0, key: 0, paths: 0}
const levelTotals = new Map(LEVELS.map(l => [l, {ms: 0, size: 0}]))

for (const [artifactType, patterns, shardLength] of DEFINITIONS) {
    if (ENTRY_FILTER && !artifactType.includes(ENTRY_FILTER)) continue

    const pattern = absolute(patterns)
    const {result: matched, ms: resolveMs} = timed(() => resolveEntryPattern(pattern))
    totals.resolve += resolveMs
    totals.paths += matched.length

    if (matched.length === 0) {
        console.log(`${artifactType.padEnd(22)} no matches`)
        continue
    }

    // Partition into shards exactly as the extractor does.
    const {result: shards, ms: partitionMs} = timed(() => {
        if (shardLength === 0) return new Map([['', matched]])
        const byShard = new Map()
        for (const file of matched) {
            const suffix = shardSuffixForPath(file, shardLength)
            if (suffix === undefined) continue
            const shard = byShard.get(suffix)
            if (shard) shard.push(file)
            else byShard.set(suffix, [file])
        }
        return byShard
    })
    totals.partition += partitionMs

    const {ms: keyMs} = timed(() => {
        for (const [suffix, files] of shards) {
            hashFileNames(files.map(relative))
            if (suffix !== '') shardPattern(pattern, suffix)
        }
    })
    totals.key += keyMs

    const shardSizes = [...shards.values()].map(f => f.length)
    console.log(
        `${artifactType.padEnd(22)} ${String(matched.length).padStart(7)} paths  ` +
            `${shards.size} entr${shards.size === 1 ? 'y' : 'ies'} ` +
            `(min ${Math.min(...shardSizes)} / max ${Math.max(...shardSizes)})  ` +
            `resolve ${resolveMs.toFixed(0)} ms  partition ${partitionMs.toFixed(0)} ms  key ${keyMs.toFixed(0)} ms`
    )

    if (FANOUT) {
        const allShards = [...shards.values()]
        await archiveAll(allShards, 4, 3) // warm-up, discarded
        for (const limit of FANOUT) {
            const fanoutMs = await archiveAll(allShards, limit, 3)
            console.log(
                `${''.padEnd(22)}   ${String(allShards.length).padStart(2)} entries, ` +
                    `${String(limit).padStart(2)} at a time: ${fanoutMs.toFixed(0).padStart(7)} ms`
            )
        }
        continue
    }

    // Archive the largest shard only: it is the one that sets the wall-clock for the entry.
    const largest = [...shards.values()].sort((a, b) => b.length - a.length)[0]
    archive(largest, 3) // warm-up, discarded: brings the shard's files into the page cache
    for (const level of LEVELS) {
        const runs = Array.from({length: REPS}, () => archive(largest, level))
        const archiveMs = Math.min(...runs.map(run => run.ms))
        const size = runs[0].size
        const total = levelTotals.get(level)
        total.ms += archiveMs
        total.size += size
        console.log(
            `${''.padEnd(22)}   level ${String(level).padStart(2)}: ` +
                `${archiveMs.toFixed(0).padStart(6)} ms  ${mib(size).padStart(8)} MB  ` +
                `(largest shard, ${largest.length} paths)`
        )
    }
}

console.log(`\nAction phases over ${totals.paths} matched paths:`)
console.log(`  resolve entry patterns   ${totals.resolve.toFixed(0).padStart(7)} ms`)
console.log(`  partition into shards    ${totals.partition.toFixed(0).padStart(7)} ms`)
console.log(`  hash cache keys          ${totals.key.toFixed(0).padStart(7)} ms`)
if (!FANOUT) {
console.log(`\nArchive creation, summed over the largest shard of every entry:`)
for (const [level, {ms: levelMs, size}] of levelTotals) {
    console.log(
        `  zstd level ${String(level).padStart(2)}         ${levelMs.toFixed(0).padStart(7)} ms  ${mib(size).padStart(9)} MB`
    )
}
}

fs.rmSync(tmpDir, {recursive: true, force: true})
