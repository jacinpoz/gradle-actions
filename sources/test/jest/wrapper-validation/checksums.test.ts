import * as checksums from '../../../src/wrapper-validation/checksums'
import nock from 'nock'
import {afterEach, describe, expect, it, test, jest} from '@jest/globals'

jest.setTimeout(60000)

const CHECKSUM_8_1 = 'ed2c26eba7cfb93cc2b7785d05e534f07b5b48b5e7fc941921cd098628abca58'

function knownChecksumsWithout8_1(): checksums.WrapperChecksums {
  const knownChecksums = new checksums.WrapperChecksums()
  // iterate over all known checksums and add them to the knownChecksums object
  for (const [checksum, versions] of checksums.KNOWN_CHECKSUMS.checksums) {
    if (checksum !== CHECKSUM_8_1) {
      for (const version of versions) {
        knownChecksums.add(version, checksum)
      }
    }
  }
  return knownChecksums
}


test('has loaded hardcoded wrapper jars checksums', async () => {
  // Sanity check that generated checksums file is not empty and was properly imported
  expect(checksums.KNOWN_CHECKSUMS.checksums.size).toBeGreaterThan(10)
  // Verify that checksums of arbitrary versions are contained
  expect(
    checksums.KNOWN_CHECKSUMS.checksums.get(
      '660ab018b8e319e9ae779fdb1b7ac47d0321bde953bf0eb4545f14952cfdcaa3'
    )
  ).toEqual(new Set(['4.10.3']))
  expect(
    checksums.KNOWN_CHECKSUMS.checksums.get(
      '28b330c20a9a73881dfe9702df78d4d78bf72368e8906c70080ab6932462fe9e'
    )
  ).toEqual(new Set(['6.0-rc-1', '6.0-rc-2', '6.0-rc-3', '6.0', '6.0.1']))
})

test('fetches wrapper jar checksums that are missing from hardcoded set', async () => {
  const unknownChecksums = await checksums.fetchUnknownChecksums(false, knownChecksumsWithout8_1())

  expect(unknownChecksums.checksums.size).toBeGreaterThan(0)
  expect(unknownChecksums.checksums.has(CHECKSUM_8_1)).toBe(true)
  expect(unknownChecksums.checksums.get(CHECKSUM_8_1)).toEqual(new Set(['8.1-rc-1', '8.1-rc-2', '8.1-rc-3', '8.1-rc-4', '8.1', '8.1.1']))
})

test('fetches wrapper jar checksums for snapshots', async () => {
  const knownChecksums = knownChecksumsWithout8_1()
  const nonSnapshotChecksums = await checksums.fetchUnknownChecksums(false, knownChecksums)
  const allValidChecksums = await checksums.fetchUnknownChecksums(true, knownChecksums)

  // Should always be many more snapshot versions
  expect(allValidChecksums.versions.size - nonSnapshotChecksums.versions.size).toBeGreaterThan(20)
  // May not be any unique snapshot checksums
  expect(allValidChecksums.checksums.size).toBeGreaterThanOrEqual(nonSnapshotChecksums.checksums.size)
})

describe('retry', () => {
  afterEach(() => {
    nock.cleanAll()
    nock.restore()
  })

  describe('for /versions/all API', () => {
    test('retry three times', async () => {
      nock('https://services.gradle.org', {allowUnmocked: true})
        .get('/versions/all')
        .times(3)
        .replyWithError(
            Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' }),
        )

      const validChecksums = await checksums.fetchUnknownChecksums(false, knownChecksumsWithout8_1())
      expect(validChecksums.checksums.size).toBeGreaterThan(0)
      nock.isDone()
    })
  })
})

// Markup captured verbatim from https://services.gradle.org/distributions-snapshots/. The links are
// matched by pattern rather than by parsing the document, so the test pins that against the real page
// shape: a breadcrumb whose links must not match, a '.jar.sha256' that must, and sibling '.jar.asc'
// and '.zip' entries for the same version that must not.
const SNAPSHOT_INDEX_PAGE = `
<div class="breadcrumb">
        <ul>
        <li><a href="/"> services.gradle.org</a>/</li><li><a href="/distributions-snapshots"> distributions-snaphosts</a>/</li>
        </ul>
    </div>
    <ul class="items">
        <li>
            <a href="/distributions-snapshots/gradle-9.7.1-20260814014720+0000-wrapper.jar.sha256"><img src="/images/file.gif">
                <span class="name">gradle-9.7.1-20260814014720+0000-wrapper.jar.sha256</span>
            </a>
        </li>
        <li>
            <a href="/distributions-snapshots/gradle-9.7.1-20260814014720+0000-wrapper.jar.asc"><img src="/images/file.gif">
                <span class="name">gradle-9.7.1-20260814014720+0000-wrapper.jar.asc</span>
            </a>
        </li>
        <li>
            <a href="/distributions-snapshots/gradle-9.8.0-20260814002830+0000-wrapper.jar.sha256"><img src="/images/file.gif">
                <span class="name">gradle-9.8.0-20260814002830+0000-wrapper.jar.sha256</span>
            </a>
        </li>
        <li>
            <a href="/distributions-snapshots/gradle-9.7.1-20260814014720+0000-docs.zip"><img src="/images/file.gif">
                <span class="name">gradle-9.7.1-20260814014720+0000-docs.zip</span>
            </a>
        </li>
    </ul>`

describe('parseSnapshotChecksumUrls', () => {
    it('finds every wrapper checksum link and nothing else', () => {
        expect(checksums.parseSnapshotChecksumUrls(SNAPSHOT_INDEX_PAGE)).toEqual([
            [
                '9.7.1-20260814014720+0000',
                'https://services.gradle.org/distributions-snapshots/gradle-9.7.1-20260814014720+0000-wrapper.jar.sha256'
            ],
            [
                '9.8.0-20260814002830+0000',
                'https://services.gradle.org/distributions-snapshots/gradle-9.8.0-20260814002830+0000-wrapper.jar.sha256'
            ]
        ])
    })

    it('finds nothing in a page with no wrapper checksums', () => {
        expect(checksums.parseSnapshotChecksumUrls('<ul><li><a href="/distributions-snapshots/gradle-9.7.1-bin.zip">x</a></li></ul>')).toEqual(
            []
        )
    })

    it('does not match a checksum link for something other than the wrapper jar', () => {
        // '-bin.zip.sha256' ends in .sha256 but is not a wrapper jar, and must not be collected.
        expect(
            checksums.parseSnapshotChecksumUrls('<a href="/distributions-snapshots/gradle-9.7.1-bin.zip.sha256">x</a>')
        ).toEqual([])
    })
})
