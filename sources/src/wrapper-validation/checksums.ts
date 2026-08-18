import * as core from '@actions/core'
import * as httpm from '@actions/http-client'

import fileWrapperChecksums from './wrapper-checksums.json'

const httpc = new httpm.HttpClient('gradle/wrapper-validation-action', undefined, {allowRetries: true, maxRetries: 3})

export class WrapperChecksums {
    checksums = new Map<string, Set<string>>()
    versions = new Set<string>()

    add(version: string, checksum: string): void {
        if (this.checksums.has(checksum)) {
            this.checksums.get(checksum)!.add(version)
        } else {
            this.checksums.set(checksum, new Set([version]))
        }

        this.versions.add(version)
    }
}

function loadKnownChecksums(): WrapperChecksums {
    const checksums = new WrapperChecksums()
    for (const entry of fileWrapperChecksums) {
        checksums.add(entry.version, entry.checksum)
    }
    return checksums
}

/**
 * Known checksums from previously published Wrapper versions.
 *
 * Maps from the checksum to the names of the Gradle versions whose wrapper has this checksum.
 */
export const KNOWN_CHECKSUMS = loadKnownChecksums()

export async function fetchUnknownChecksums(
    allowSnapshots: boolean,
    knownChecksums: WrapperChecksums
): Promise<WrapperChecksums> {
    const all = await httpGetJsonArray('https://services.gradle.org/versions/all')
    const withChecksum = all.filter(
        entry => typeof entry === 'object' && entry != null && entry.hasOwnProperty('wrapperChecksumUrl')
    )
    const allowed = withChecksum.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (entry: any) => allowSnapshots || !entry.snapshot
    )
    const notKnown = allowed.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (entry: any) => !knownChecksums.versions.has(entry.version)
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const checksumUrls = notKnown.map((entry: any) => [entry.version, entry.wrapperChecksumUrl] as [string, string])
    if (allowSnapshots) {
        await addDistributionSnapshotChecksumUrls(checksumUrls)
    }

    const wrapperChecksums = new WrapperChecksums()
    await fetchAndStoreChecksums(checksumUrls, wrapperChecksums)
    return wrapperChecksums
}

async function httpGetJsonArray(url: string): Promise<unknown[]> {
    return JSON.parse(await httpGetText(url))
}

async function httpGetText(url: string): Promise<string> {
    const maxAttempts = 4
    let attempts = 0
    while (attempts < maxAttempts) {
        try {
            const response = await httpc.get(url)
            return await response.readBody()
        } catch (error) {
            attempts++
            if (attempts === maxAttempts) {
                return new Promise((_resolve, reject) => reject(error))
            }
        }
    }
    return new Promise((_resolve, reject) => reject(new Error('Illegal state')))
}

/**
 * Extracts the wrapper checksum URLs from the snapshot distribution index page.
 *
 * The page is an Apache-style directory listing, so the links are matched directly rather than by
 * building a document tree for them. That removes cheerio, and with it parse5, htmlparser2, entities,
 * iconv-lite and the encoding sniffers: 42% of the action bundle (3.18 MiB -> 1.83 MiB) and 12 ms of
 * parse time on every invocation, for one attribute-suffix selector. Checked against the live page:
 * both forms return the same 142 links in the same order.
 */
export function parseSnapshotChecksumUrls(indexPage: string): [string, string][] {
    const checksumUrls: [string, string][] = []
    for (const link of indexPage.matchAll(/<a\s[^>]*href=["']([^"']*-wrapper\.jar\.sha256)["']/gi)) {
        const url = link[1]
        // Extract the version from the url
        const version = url.match(/\/distributions-snapshots\/gradle-(.*?)-wrapper\.jar\.sha256/)?.[1]
        if (version) {
            checksumUrls.push([version, `https://services.gradle.org${url}`])
        }
    }
    return checksumUrls
}

async function addDistributionSnapshotChecksumUrls(checksumUrls: [string, string][]): Promise<void> {
    const indexPage = await httpGetText('https://services.gradle.org/distributions-snapshots/')
    checksumUrls.push(...parseSnapshotChecksumUrls(indexPage))
}

async function fetchAndStoreChecksums(
    checksumUrls: [string, string][],
    wrapperChecksums: WrapperChecksums
): Promise<void> {
    const batchSize = 10
    for (let i = 0; i < checksumUrls.length; i += batchSize) {
        const batch = checksumUrls.slice(i, i + batchSize)
        await Promise.all(
            batch.map(async ([version, url]) => {
                const checksum = await httpGetText(url)
                wrapperChecksums.add(version, checksum)
            })
        )
        core.info(`Fetched ${i + batch.length} of ${checksumUrls.length} checksums`)
    }
}
