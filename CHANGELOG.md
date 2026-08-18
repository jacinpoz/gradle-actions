# Changelog

This is an unofficial derivative of [gradle/actions](https://github.com/gradle/actions). See
[NOTICE](NOTICE) for attribution and [README](README.md) for why the fork exists.

## v1.2.0

Sharding is now decided by size rather than fixed at sixteen. That is worth doing because v1.1.0's
incremental saves took over the job sharding was introduced for.

### Bundles are split only as far as their size requires

A large cache entry used to be split across 16 entries unconditionally. Every shard is a separate lookup and
download when restoring and three round trips when saving, so that cost was paid whether or not the bundle
was large enough to need it.

The number is now chosen from how large the bundle's archives came to on the previous run: as few as keeps
one entry under a gigabyte, and no more. Most Gradle User Homes will find their bundles fit in one entry
each.

Measured against a local stand-in for the GitHub Actions cache service, with a shared 100 MB/s limit and
50 ms of round-trip latency, over six successive jobs:

| | 16 shards (v1.1.0) | chosen by size |
| --- | --- | --- |
| Restoring the Gradle User Home | 3924 ms | **2593 ms** |
| Saving, no compaction due | ~1440 ms | **~910 ms** |
| Cache entries after six jobs | 238 | **92** |
| Uploaded across those six jobs | 233 MB | 224 MB |

The last row is the point: sharding never reduced what was written. It spread compaction over more rounds —
one 204 MB spike became 36, 124 and 58 MB — while making every restore slower. Restores are paid by every
job and compaction only by a job that writes.

Splitting further is actively harmful, which is why the ceiling is a size and not a count: 256 shards
restored in 4241 → 12685 ms as entries accumulated, against 2199 → 2547 ms for one.

### What this costs once

Nothing is known about a bundle's size until a run has saved it, so a cold cache still splits a large bundle
16 ways, and the following run settles on the right number. Changing the number changes what each entry
holds, so that run saves those bundles in full once — measured at 195 MB for the fixture above, after which
each job was back to 4 MB. Upgrading from v1.1.0 pays this once, on the first job that writes.

### New environment switch

| variable | effect |
| --- | --- |
| `GRADLE_ACTIONS_CACHE_SHARDS` | fix the shard count at 1, 2, 4, 8 or 16 instead of choosing by size |

### Compatibility

Entries written by v1.1.0 are readable, and their recorded sizes are what v1.2.0 uses to choose. Going back
to v1.1.0 is safe: it ignores the size and shard-count fields it does not know and returns to sixteen.

**Full changelog**: https://github.com/jacinpoz/gradle-actions/compare/v1.1.0...v1.2.0

## v1.1.0

Caching. A job now uploads what its build actually added, rather than re-uploading whole cache entries
because part of them changed.

### Highlights

| | before | after |
|---|---|---|
| Uploaded by a job that added 400 artifact transforms and 20 dependencies | 198 MB | **5 MB** |
| Time to save it | 2206 ms | **580 ms** |
| Saving 66 cache entries | 3051 ms | **2693 ms** |
| Event loop turns available to uploads while extracted content is deleted | 0 of 21 | **21 of 21** |

Measured on Linux against a local stand-in for the GitHub Actions cache service with a 100 MB/s limit
shared by every transfer, on four cores. Every measurement also verified that the Gradle User Home after
restoring held everything it held before saving.

### Cache entries are saved incrementally

An extracted cache entry is now a base plus up to three layers, and each save stores only the paths the
build added. Previously any change to an entry re-saved all of it, so resolving one new dependency
re-uploaded a sixteenth of every dependency the job had.

New content is recognised by its modification time, because `tar` restores the time recorded in the
archive: nothing about the restored content has to be stored to compare against, which matters when an
entry covers 186k paths. The cutoff is placed a second before the restore, so that a filesystem holding
modification times more coarsely than the clock cannot make content written moments after the restore look
as though it had been restored, and go unsaved.

A chain is collapsed back into a single entry when it is full, when the delta approaches the size of a
fresh base, or when much of what it restored has since been pruned by cache cleanup — a layer can only add
paths, so it cannot express a removal.

### The local build cache is cached separately

`caches/build-cache-1` is named by content hash like the other large directories, but it sat inside the
main Gradle User Home entry, which is keyed on the commit and so is re-uploaded in full on every run. It is
now extracted and sharded like the rest, and therefore also saved incrementally.

Its `gc.properties` and `build-cache-1.lock` end in no hex character, so they belong to no shard and stay
where they are.

### Restore no longer queues behind the largest entry

The metadata naming the extracted entries used to live inside the main entry, so nothing else could start
until the largest download had finished. It is now a small entry of its own, restored first, after which
the main entry and every extracted entry transfer at once.

How much this is worth depends on how much content the main entry holds that no extracted entry claims:
1.8% of restore time for a Gradle User Home where almost everything is extracted, 5.0% with a further
200 files that only the main entry holds.

### Entries transfer a few at a time

Every entry runs a `tar` piped through a multi-threaded compressor, plus its own transfers, so starting all
of them at once put around fifty compressors on a four-core runner. Measured across the whole range,
concurrency pays up to about eight and then stops: saving 66 entries took 3592 ms one at a time, 2693 ms
eight at a time, and 3051 ms unbounded.

### Smaller fixes

- Deleting extracted content no longer stalls the uploads meant to be in flight beside it. It was a
  synchronous loop that took every turn of the event loop with it. It is still synchronous — deleting
  asynchronously measured 1.8x slower — but yields every 64 paths.
- That deletion is also awaited. It was not, so a path that could not be deleted left a rejected promise
  unhandled, which ends the post-action step.
- A bundle is only split into shards once there is enough content for it to pay. Sixteen entries each
  holding a handful of paths cost sixteen reservations, uploads and finalizations to store what one entry
  would.
- The matched paths are handed to `@actions/cache` rather than left to be resolved a second time, which for
  a sharded bundle repeated the same directory reads once per shard.
- Excluded paths are resolved by targeted `readdir` where the pattern allows it, as the entry patterns
  already were.
- The job summary reports the time spent in the action's own phases — resolving patterns, hashing keys,
  finding new paths, deleting extracted content — which the per-entry transfer times hid.

### New environment switches

None of the action's inputs changed. Each of the above can be turned off:

| variable | effect |
|---|---|
| `GRADLE_ACTIONS_CACHE_LAYERS=false` | save every entry in full, as v1.0.0 did |
| `GRADLE_ACTIONS_CACHE_PARALLEL_RESTORE=false` | restore entries one after the other, without the index entry |
| `GRADLE_ACTIONS_CACHE_ENTRY_CONCURRENCY=<n>` | how many entries to transfer at once |

### Compatibility

Cache entries written by v1.0.0 are read by v1.1.0 and vice versa. The cache protocol version is unchanged:
metadata written before layering existed reads as a single-layer chain, so upgrading forces no cold start,
and downgrading ignores the layers it does not understand.

### Measured and rejected

Recorded so that they are not revisited without new evidence:

- **Compression level.** `zstd` level 3, the default, is already the right choice. Level 6 costs 549 ms to
  save 18 MB on the transforms entry, and level 1 saves nothing worth having on already-compressed jars
  (209 ms for 0.7 MB of 3.1 GB). Level is not part of the cache version, so this can be revisited freely.
- **Compressor thread count.** `zstdmt` ignores `ZSTD_NBTHREADS`; its implied `-T0` takes precedence, so
  this cannot be set without patching `@actions/cache` further.
- **Upload and download concurrency.** The v2 cache service already forces 8 workers and 64 MiB chunks.

### Known limits

- The main Gradle User Home entry is keyed on the commit and is still re-uploaded in full every run.
  Layering cannot help it. For a Gradle User Home holding a lot of content that no extracted entry claims,
  this is now the floor on how little a job can upload.
- A prune that the build's own additions exactly offset is not detected, so the pruned paths return with
  the base on the next restore. This wastes a little space and is not incorrect; cleanup prunes them again.
- Sharding fragments a small delta across all sixteen shards: a 3 MB delta was observed to cost 19 cache
  entries. Sixteen shards may no longer be the right number now that entries are layered.

**Full changelog**: https://github.com/jacinpoz/gradle-actions/compare/v1.0.0...v1.1.0

## v1.0.0

The initial release of the fork, imported from `gradle/actions` v5.0.2 — the last release whose caching
implementation is MIT-licensed.

- Resolved the npm advisories left unpatched by the frozen v5 branch: `npm audit` went from 21 findings
  (3 critical, 10 high) to 1 low, development-only advisory that is never shipped in `dist/`.
- Removed `@gradle-tech/develocity-agent`, a proprietary package the vendored test configuration required
  but upstream never declared, so the test suite runs from a clean checkout.
- Fixed extracted-entry caching on Windows, where every cache entry pattern resolved to nothing because the
  pattern root was rebuilt from the path separator, turning `D:\...` into `\D:\...`.
- Fixed saving a large cache at all: `@actions/glob` spread a directory's children into `stack.push(...)`,
  which overflowed the call stack on a directory holding ~178k entries.
- Resolved cache entry patterns by targeted `readdir` instead of walking each pattern's search root:
  10,082 ms to 103 ms for the transforms entry.
- Sharded the large bundle entries 16 ways on the trailing character of Gradle's content hash.
- Stopped shipping source maps and dropped `cheerio`, taking the repository downloaded per job from
  15.5 MB to 2.7 MB and the `setup-gradle` bundle from 4.7 MB to 1.8 MB.
