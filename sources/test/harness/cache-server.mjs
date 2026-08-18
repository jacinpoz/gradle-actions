// A local stand-in for the GitHub Actions cache service (the v1 API that '@actions/cache' uses when
// ACTIONS_CACHE_SERVICE_V2 is unset), so that the action's save and restore can be measured and verified
// end to end: real HTTP, real chunked uploads, real tar and zstd.
//
// Bandwidth is limited by one token bucket shared by every transfer, as a single network interface is, so
// that measuring the effect of transferring more entries at once means something.
//
// Run: node cache-server.mjs <storageDir> [--port=0] [--mbps=100]
import fs from 'fs'
import http from 'http'
import path from 'path'

const storage = process.argv[2]
const flag = (name, fallback) => {
    const found = process.argv.find(a => a.startsWith(`--${name}=`))
    return found ? Number(found.split('=')[1]) : fallback
}
const port = flag('port', 0)
const megabytesPerSecond = flag('mbps', 0)

fs.mkdirSync(storage, {recursive: true})

/** key+version -> {cacheKey, version, id, size, committed} */
const entries = new Map()
let nextId = 1
const archivePath = id => path.join(storage, `${id}.tzst`)
const entryId = (key, version) => `${key} ${version}`

// One bucket for every transfer in either direction. Unlimited when no rate is given.
const BYTES_PER_MS = (megabytesPerSecond * 1024 * 1024) / 1000
// A small burst allowance, so that the sustained rate is what governs. A generous one lets an idle gap
// bank enough credit to pass a whole cache entry at once, which is not a network.
const BURST_MS = 50
let available = BYTES_PER_MS * BURST_MS
let lastRefill = Date.now()
async function consume(bytes) {
    if (!megabytesPerSecond) return
    for (;;) {
        const now = Date.now()
        available = Math.min(available + (now - lastRefill) * BYTES_PER_MS, BYTES_PER_MS * BURST_MS)
        lastRefill = now
        if (available >= bytes) {
            available -= bytes
            return
        }
        const waitMs = Math.max(1, Math.ceil((bytes - available) / BYTES_PER_MS))
        await new Promise(resolve => setTimeout(resolve, waitMs))
    }
}

const json = (res, status, body) => {
    res.writeHead(status, {'Content-Type': 'application/json'})
    res.end(body === undefined ? '' : JSON.stringify(body))
}

async function readBody(req) {
    const chunks = []
    for await (const chunk of req) {
        await consume(chunk.length)
        chunks.push(chunk)
    }
    return Buffer.concat(chunks)
}

/** Exact match on the first key, then the most recent prefix match on the rest, as the service does. */
function lookup(keys, version) {
    const committed = [...entries.values()].filter(e => e.version === version && e.committed)
    const exact = committed.find(e => e.cacheKey === keys[0])
    if (exact) return exact
    for (const key of keys) {
        const matches = committed.filter(e => e.cacheKey.startsWith(key)).sort((a, b) => b.id - a.id)
        if (matches.length > 0) return matches[0]
    }
    return undefined
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost')
        // The download URL is served from the root, so the API prefix is not always there to strip.
        const route = url.pathname.replace('/_apis/artifactcache/', '').replace(/^\//, '')

        if (route === '__stats') {
            const committed = [...entries.values()].filter(e => e.committed)
            return json(res, 200, {
                entries: committed.length,
                bytes: committed.reduce((total, e) => total + e.size, 0),
                keys: committed.map(e => ({key: e.cacheKey, size: e.size}))
            })
        }
        if (route === '__reset') {
            entries.clear()
            fs.rmSync(storage, {recursive: true, force: true})
            fs.mkdirSync(storage, {recursive: true})
            return json(res, 200, {ok: true})
        }

        // GET cache?keys=a,b&version=v  -- look up an entry
        if (req.method === 'GET' && route === 'cache') {
            const keys = (url.searchParams.get('keys') ?? '').split(',')
            const version = url.searchParams.get('version') ?? ''
            const found = lookup(keys, version)
            if (!found) return json(res, 204)
            return json(res, 200, {
                cacheKey: found.cacheKey,
                scope: 'refs/heads/main',
                archiveLocation: `http://localhost:${server.address().port}/download/${found.id}`
            })
        }

        // GET download/<id> -- stream the archive back
        if (req.method === 'GET' && route.startsWith('download/')) {
            const id = Number(route.slice('download/'.length))
            const file = archivePath(id)
            if (!fs.existsSync(file)) {
                console.error(`download miss for id ${id}`)
                return json(res, 404, {message: 'no such archive'})
            }
            const size = fs.statSync(file).size
            res.writeHead(200, {'Content-Length': `${size}`, 'Content-Type': 'application/octet-stream'})
            const handle = await fs.promises.open(file, 'r')
            try {
                const buffer = Buffer.allocUnsafe(1024 * 1024)
                for (let offset = 0; offset < size; ) {
                    const {bytesRead} = await handle.read(buffer, 0, buffer.length, offset)
                    if (bytesRead === 0) break
                    await consume(bytesRead)
                    if (!res.write(buffer.subarray(0, bytesRead))) {
                        await new Promise(resolve => res.once('drain', resolve))
                    }
                    offset += bytesRead
                }
            } finally {
                await handle.close()
            }
            return res.end()
        }

        // POST caches -- reserve
        if (req.method === 'POST' && route === 'caches') {
            const {key, version} = JSON.parse((await readBody(req)).toString() || '{}')
            const id = entryId(key, version)
            if (entries.has(id)) return json(res, 409, {message: 'already exists'})
            const cacheId = nextId++
            entries.set(id, {cacheKey: key, version, id: cacheId, size: 0, committed: false})
            fs.writeFileSync(archivePath(cacheId), '')
            return json(res, 201, {cacheId})
        }

        // PATCH caches/<id> -- upload one chunk at a byte range
        if (req.method === 'PATCH' && route.startsWith('caches/')) {
            const cacheId = Number(route.slice('caches/'.length))
            const range = req.headers['content-range'] ?? ''
            const start = Number(/bytes (\d+)-/.exec(range)?.[1] ?? 0)
            const body = await readBody(req)
            const handle = await fs.promises.open(archivePath(cacheId), 'r+')
            try {
                await handle.write(body, 0, body.length, start)
            } finally {
                await handle.close()
            }
            return json(res, 200, {})
        }

        // POST caches/<id> -- commit
        if (req.method === 'POST' && route.startsWith('caches/')) {
            const cacheId = Number(route.slice('caches/'.length))
            const {size} = JSON.parse((await readBody(req)).toString() || '{}')
            const entry = [...entries.values()].find(e => e.id === cacheId)
            const actual = fs.statSync(archivePath(cacheId)).size
            if (!entry) return json(res, 404, {message: 'not reserved'})
            if (size !== undefined && actual !== size) {
                return json(res, 400, {message: `size mismatch: committed ${size}, received ${actual}`})
            }
            entry.size = actual
            entry.committed = true
            return json(res, 204)
        }

        console.error(`unhandled ${req.method} ${url.pathname}`)
        return json(res, 404, {message: `unhandled ${req.method} ${url.pathname}`})
    } catch (error) {
        json(res, 500, {message: `${error}`})
    }
})

server.listen(port, '127.0.0.1', () => {
    // The bench reads this line to learn the port.
    console.log(`CACHE_SERVER_PORT=${server.address().port}`)
})
