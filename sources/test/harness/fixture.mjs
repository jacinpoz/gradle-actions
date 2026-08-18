// Builds a Gradle User Home to save and restore, shaped like a real one: content-addressed directory
// names so the shards fall where they would, a few hundred megabytes of real jars so that compression and
// transfer behave realistically, and enough directories that pattern resolution and deletion are not free.
//
// Real jars are copied from the local Gradle cache when there is one, because synthetic bytes compress
// nothing like a jar does. Falls back to incompressible random bytes when there is not.
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

const HEX = '0123456789abcdef'

/** Names a directory as Gradle does: after a content hash, so its shard follows from the name. */
function hashName(seed, length = 32) {
    return crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, length)
}

function findRealJars(limit) {
    const modules = path.join(os.homedir(), '.gradle/caches/modules-2/files-2.1')
    if (!fs.existsSync(modules)) return []
    const jars = []
    const walk = (dir, depth) => {
        if (jars.length >= limit) return
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (jars.length >= limit) return
            const full = path.join(dir, entry.name)
            if (entry.isDirectory() && depth < 5) walk(full, depth + 1)
            else if (entry.isFile() && entry.name.endsWith('.jar')) {
                const {size} = fs.statSync(full)
                // Skip the very large ones so the fixture stays a predictable size.
                if (size > 8 * 1024 && size < 4 * 1024 * 1024) jars.push(full)
            }
        }
    }
    walk(modules, 0)
    return jars
}

/**
 * @param root where to build it
 * @param scale {transforms, dependencies, buildCache, kotlinDsl} directory counts
 */
export function buildFixture(root, scale) {
    fs.rmSync(root, {recursive: true, force: true})
    fs.mkdirSync(path.join(root, '.setup-gradle'), {recursive: true})

    const jars = findRealJars(400)
    let jarIndex = 0
    const nextJar = () => (jars.length > 0 ? jars[jarIndex++ % jars.length] : undefined)

    // caches/<version>/transforms/<hash>/ -- many small directories
    const transformsRoot = path.join(root, 'caches/9.6.1/transforms')
    for (let i = 0; i < scale.transforms; i++) {
        const dir = path.join(transformsRoot, hashName(`transform-${i}`))
        fs.mkdirSync(path.join(dir, 'transformed'), {recursive: true})
        fs.writeFileSync(path.join(dir, 'metadata.bin'), Buffer.alloc(512, i % 251))
        fs.writeFileSync(path.join(dir, 'transformed', 'classes.txt'), `transform ${i}\n`.repeat(20))
    }

    // caches/modules-2/files-2.1/<group>/<name>/<version>/<sha1>/<file> -- most of the bytes
    for (let i = 0; i < scale.dependencies; i++) {
        const sha1 = hashName(`dependency-${i}`, 40)
        const dir = path.join(
            root,
            'caches/modules-2/files-2.1',
            `org.example.group${i % 20}`,
            `artifact-${i % 50}`,
            `1.${i % 9}.0`,
            sha1
        )
        fs.mkdirSync(dir, {recursive: true})
        const jar = nextJar()
        const target = path.join(dir, `artifact-${i % 50}-1.${i % 9}.0.jar`)
        if (jar) fs.copyFileSync(jar, target)
        else fs.writeFileSync(target, crypto.randomBytes(256 * 1024))
    }

    // caches/build-cache-1/<hash> -- files, not directories, plus the two that must stay behind
    const buildCacheRoot = path.join(root, 'caches/build-cache-1')
    fs.mkdirSync(buildCacheRoot, {recursive: true})
    for (let i = 0; i < scale.buildCache; i++) {
        fs.writeFileSync(path.join(buildCacheRoot, hashName(`build-cache-${i}`)), Buffer.alloc(48 * 1024, i % 251))
    }
    fs.writeFileSync(path.join(buildCacheRoot, 'gc.properties'), '')
    fs.writeFileSync(path.join(buildCacheRoot, 'build-cache-1.lock'), '')

    // caches/<version>/kotlin-dsl/{accessors,scripts}/<hash>/
    for (const kind of ['accessors', 'scripts']) {
        for (let i = 0; i < scale.kotlinDsl; i++) {
            const dir = path.join(root, 'caches/9.6.1/kotlin-dsl', kind, hashName(`${kind}-${i}`))
            fs.mkdirSync(dir, {recursive: true})
            fs.writeFileSync(path.join(dir, 'classes.jar'), Buffer.alloc(16 * 1024, i % 251))
        }
    }

    // Content that stays in the main entry: not matched by any extracted entry pattern. How much of this a
    // Gradle User Home holds decides how large the main entry is, and therefore how much there is to gain
    // from not making every other entry wait for it.
    const scriptsRoot = path.join(root, 'caches/9.6.1/scripts')
    fs.mkdirSync(scriptsRoot, {recursive: true})
    for (let i = 0; i < (scale.homeOnlyMegabytes ?? 0); i++) {
        const jar = nextJar()
        const target = path.join(scriptsRoot, `compiled-${i}.jar`)
        if (jar) fs.copyFileSync(jar, target)
        else fs.writeFileSync(target, crypto.randomBytes(1024 * 1024))
    }

    fs.mkdirSync(path.join(root, 'caches/journal-1'), {recursive: true})
    fs.writeFileSync(path.join(root, 'caches/journal-1/file-access.bin'), Buffer.alloc(4 * 1024 * 1024, 7))
    fs.mkdirSync(path.join(root, 'notifications'), {recursive: true})
    fs.writeFileSync(path.join(root, 'notifications/release-features.rendered'), 'x')

    return {usedRealJars: jars.length}
}

/** Every file and directory under the root, relative to it, sorted: the fingerprint to compare against. */
export function inventory(root) {
    const names = []
    const walk = current => {
        for (const entry of fs.readdirSync(current, {withFileTypes: true}).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const full = path.join(current, entry.name)
            names.push(path.relative(root, full))
            if (entry.isDirectory()) walk(full)
        }
    }
    walk(root)
    return names
}

export function totalBytes(root) {
    let bytes = 0
    const walk = current => {
        for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
            const full = path.join(current, entry.name)
            if (entry.isDirectory()) walk(full)
            else bytes += fs.statSync(full).size
        }
    }
    walk(root)
    return bytes
}

/**
 * Adds content as a build would: new transform directories and new dependency artifacts, named by hashes
 * that no existing entry uses. Returns their paths relative to the root.
 */
export function mutate(root, counts) {
    const added = []
    const record = full => added.push(path.relative(root, full))

    for (let i = 0; i < (counts.transforms ?? 0); i++) {
        const dir = path.join(root, 'caches/9.6.1/transforms', hashName(`added-transform-${i}`))
        fs.mkdirSync(path.join(dir, 'transformed'), {recursive: true})
        fs.writeFileSync(path.join(dir, 'metadata.bin'), Buffer.alloc(512, i % 251))
        fs.writeFileSync(path.join(dir, 'transformed', 'classes.txt'), `added ${i}\n`.repeat(20))
        record(dir)
        record(path.join(dir, 'metadata.bin'))
        record(path.join(dir, 'transformed'))
        record(path.join(dir, 'transformed', 'classes.txt'))
    }

    const jars = findRealJars(50)
    for (let i = 0; i < (counts.dependencies ?? 0); i++) {
        const dir = path.join(
            root,
            'caches/modules-2/files-2.1',
            'org.example.added',
            `added-${i}`,
            '2.0.0',
            hashName(`added-dependency-${i}`, 40)
        )
        fs.mkdirSync(dir, {recursive: true})
        const target = path.join(dir, `added-${i}-2.0.0.jar`)
        if (jars.length > 0) fs.copyFileSync(jars[i % jars.length], target)
        else fs.writeFileSync(target, crypto.randomBytes(256 * 1024))
        record(path.dirname(path.dirname(path.dirname(dir))))
        record(path.dirname(path.dirname(dir)))
        record(path.dirname(dir))
        record(dir)
        record(target)
    }
    return [...new Set(added)]
}
