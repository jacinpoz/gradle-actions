// Splits the cost of resolving a cache-entry pattern into directory traversal (syscalls) vs
// pattern matching (CPU), to establish whether a faster-language / WebAssembly matcher could help.
//
//   (a) @actions/glob                      -- recursive walk + minimatch, what v5 uses
//   (b) targeted readdir                   -- readdir only at the depths the pattern needs
//   (c) targeted readdir + suffix partition -- (b) plus the sharding work
//
// If (b) is close to (a), the cost is syscalls and no compute engine can help. If (a) is far
// above (b), the excess is traversal of directories the pattern could never match, which is an
// algorithmic problem rather than a language one.
import * as glob from '@actions/glob'
import fs from 'fs'
import path from 'path'
import os from 'os'

const GUH = process.argv[2] || path.join(os.homedir(), '.gradle')
const HEX = '0123456789abcdef'.split('')

async function timed(label, fn) {
    const t0 = process.hrtime.bigint()
    const out = await fn()
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    console.log(`  ${label.padEnd(44)} ${ms.toFixed(0).padStart(7)} ms   ${out.note}`)
    return {ms, ...out}
}

// Enumerate children of every directory matching caches/<x>/transforms and caches/transforms-4
function transformRoots() {
    const caches = path.join(GUH, 'caches')
    const roots = []
    for (const e of fs.readdirSync(caches, {withFileTypes: true})) {
        if (!e.isDirectory()) continue
        if (e.name === 'transforms-4') roots.push(path.join(caches, e.name))
        const nested = path.join(caches, e.name, 'transforms')
        if (fs.existsSync(nested)) roots.push(nested)
    }
    return roots
}

function depsRoots() {
    // modules-*/files-*/<group>/<module>/<version>  -- the hash dirs are the children of these
    const caches = path.join(GUH, 'caches')
    const roots = []
    for (const m of fs.readdirSync(caches, {withFileTypes: true})) {
        if (!m.isDirectory() || !m.name.startsWith('modules-')) continue
        for (const f of fs.readdirSync(path.join(caches, m.name), {withFileTypes: true})) {
            if (!f.isDirectory() || !f.name.startsWith('files-')) continue
            const base = path.join(caches, m.name, f.name)
            for (const g of fs.readdirSync(base, {withFileTypes: true})) {
                if (!g.isDirectory()) continue
                for (const mod of fs.readdirSync(path.join(base, g.name), {withFileTypes: true})) {
                    if (!mod.isDirectory()) continue
                    const modDir = path.join(base, g.name, mod.name)
                    for (const v of fs.readdirSync(modDir, {withFileTypes: true})) {
                        if (v.isDirectory()) roots.push(path.join(modDir, v.name))
                    }
                }
            }
        }
    }
    return roots
}

function childDirs(roots) {
    const out = []
    for (const r of roots) {
        for (const e of fs.readdirSync(r, {withFileTypes: true})) {
            if (e.isDirectory()) out.push(path.join(r, e.name))
        }
    }
    return out
}

const CASES = [
    ['transforms', 'caches/transforms-4/*/\ncaches/*/transforms/*/', transformRoots],
    ['dependencies', 'caches/modules-*/files-*/*/*/*/*', depsRoots]
]

for (const [name, rawPattern, rootsFn] of CASES) {
    const pattern = rawPattern
        .split('\n')
        .map(l => (l.endsWith('/') ? `${path.resolve(GUH, l)}/` : path.resolve(GUH, l)))
        .join('\n')
    console.log(`\n=== ${name} ===`)

    const a = await timed('(a) @actions/glob [v5]', async () => {
        const g = await glob.create(pattern, {implicitDescendants: false})
        const files = await g.glob()
        return {note: `${files.length} paths`, n: files.length}
    })

    const b = await timed('(b) targeted readdir', async () => {
        const dirs = childDirs(rootsFn())
        return {note: `${dirs.length} paths`, n: dirs.length}
    })

    const c = await timed('(c) targeted readdir + partition', async () => {
        const dirs = childDirs(rootsFn())
        const shards = new Map()
        for (const d of dirs) {
            const nm = path.basename(d).toLowerCase()
            const s = nm.substring(nm.length - 1)
            if (HEX.includes(s)) shards.set(s, (shards.get(s) || 0) + 1)
        }
        return {note: `${shards.size}/16 shards over ${dirs.length} paths`}
    })

    console.log(`  -> glob is ${(a.ms / b.ms).toFixed(1)}x the cost of a targeted readdir`)
    console.log(`  -> traversal overhead attributable to pattern matching + surplus walking: ${(a.ms - b.ms).toFixed(0)} ms`)
    console.log(`  -> sharding partition itself costs: ${(c.ms - b.ms).toFixed(0)} ms`)
}
