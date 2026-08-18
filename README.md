# GitHub Actions for Gradle builds

> [!IMPORTANT]
> **This is an unofficial derivative of [gradle/actions](https://github.com/gradle/actions), not the official action.**
> It is not published, endorsed or supported by Gradle Inc. For the official action, use `gradle/actions`.
>
> See [NOTICE](NOTICE) for attribution and provenance, and the section below for what differs from upstream.

## Why this fork exists

It is derived from tag **v5.0.2**, the last release of `gradle/actions` whose caching implementation is
MIT-licensed. From v6.0.0 upstream moved caching into `gradle-actions-caching`, a closed-source component
governed by the [Gradle Technologies Terms of Use](https://gradle.com/legal/gradle-technologies-terms-of-use/),
which for private repositories is offered as a time-limited free preview.

There is no v5 maintenance branch, so v5.0.2 also never received the security fixes that went into v6.
This fork exists to stay on MIT-licensed caching and to carry those fixes forward.

## What differs from v5.0.2

**Security.** `npm audit` on the imported tree reported 21 vulnerabilities (3 critical, 10 high). It now
reports 1, which is a development-only `esbuild` advisory that is never shipped in `dist/`. The vendored
test configuration also required `@gradle-tech/develocity-agent`, a proprietary Gradle Technologies
package that upstream never declared as a dependency; it has been removed, so the test suite runs from a
clean checkout and no proprietary component remains.

**Extracted-entry caching was broken on Windows.** Cache entry patterns are anchored at the Gradle User
Home, and the resolver rebuilt each pattern's root from the path separator. On Windows that turned
`D:\...` into `\D:\...`, a path that cannot exist, so every pattern resolved to nothing: no extracted
cache entry was saved or restored. Upstream's integration tests for those entries run only on Linux.

**Large caches could not be saved at all.** `@actions/cache` resolves the paths it archives with
`@actions/glob`, which descends by spreading a directory's children into `stack.push(...)`. A
`caches/transforms-4` holding ~178k entries overflows the call stack, so saving failed outright with
`Maximum call stack size exceeded`. That ceiling sits inside the dependency, so it could not be lifted
from the action alone; it is fixed by a patch.

**Caching performance.** Cache entry patterns are resolved by reading only the directories a pattern can
match, rather than walking the tree beneath its search root and filtering, and the matched paths are then
handed to `@actions/cache` so that the work is not repeated when the archive is built. Large bundle entries
are sharded 16 ways on the trailing character of Gradle's content hash, so one changed artifact
invalidates one shard rather than the whole bundle, and shards transfer concurrently.

**Cache entries are saved incrementally.** Upstream re-saves a whole entry whenever any of its content
changes, so a job that resolves one new dependency re-uploads a sixteenth of every dependency it has. Here
each entry is a base plus up to three layers, and a job saves only what the build added: measured against a
warm cache, a job adding 400 artifact transforms and 20 dependencies uploaded 5 MB instead of 198 MB. New
content is recognised by its modification time, because `tar` restores the time recorded in the archive, so
nothing about the restored content has to be stored to compare against. A chain is collapsed back into one
entry when it is full, or when cache cleanup has pruned much of what it restored.

**The local build cache is cached separately.** `caches/build-cache-1` is named by content hash like the
other large directories, but upstream leaves it inside the main Gradle User Home entry, which is keyed on
the commit and so is re-uploaded in full on every run.

**Restore no longer queues behind the largest entry.** The metadata naming the extracted entries used to be
stored inside the main entry, so nothing else could start until it had finished downloading. It is now a
small entry of its own, restored first, after which everything transfers at once.

**Entries are transferred a few at a time.** Upstream starts every entry at once, which on a four-core
runner means around fifty `tar` processes each running a multi-threaded compressor. Measured against a
local cache service with a shared bandwidth limit, saving 66 entries took 3051 ms unbounded against 2693 ms
eight at a time.

**Action startup.** Source maps are no longer committed (nothing reads them at runtime), and `cheerio`
was replaced by a pattern match for the one directory-index scrape that used it.

| | v5.0.2 | this fork |
|---|---|---|
| `npm audit` | 21 (3 critical, 10 high) | 1 (low, dev-only) |
| Repository downloaded per job | 15.5 MB | 2.7 MB |
| `setup-gradle` bundle | 4.7 MB | 1.8 MB |
| Cache key for the `transforms` entry | ~9.5 s | 142 ms |
| Path resolution when saving that entry | crashed | 1.3 s |
| Uploaded by a job that added a little | 198 MB | 5 MB |
| Time to save it | 2206 ms | 580 ms |
| Saving 66 entries | 3051 ms | 2693 ms |
| Extracted-entry caching on Windows | broken | working |

The first four rows are measured against a Gradle User Home with ~178k transform directories. A small cache
will not see them: their value there is that the failure modes above no longer apply, not that every job
gets faster. The download and bundle reductions apply to every job unconditionally.

The incremental-save and entry-count rows come from `sources/test/harness`, which runs the action against a
local stand-in for the GitHub Actions cache service with a shared bandwidth limit, and verifies that the
Gradle User Home after restoring holds everything it held before saving. Every measurement in this file was
taken on Linux.

## Using it

Bind to the major version to pick up patch releases automatically:

```yaml
- uses: jacinpoz/gradle-actions/setup-gradle@v1
```

`v1` is moved to each new release. For a third-party action the safer choice is an immutable
reference, either the exact release tag or the commit it points at:

```yaml
- uses: jacinpoz/gradle-actions/setup-gradle@v1.0.0
```

This repository contains a set of GitHub Actions that are useful for building Gradle projects on GitHub.

## The `setup-gradle` action

The `setup-gradle` action can be used to configure Gradle for optimal execution on any platform supported by GitHub Actions.

This replaces the previous `gradle/gradle-build-action`, which now delegates to this implementation.

The recommended way to execute any Gradle build is with the help of the [Gradle Wrapper](https://docs.gradle.org/current/userguide/gradle_wrapper.html), and the examples assume that the Gradle Wrapper has been configured for the project. See [this example](docs/setup-gradle.md#build-with-a-specific-gradle-version) if your project doesn't use the Gradle Wrapper.

### Example usage

```yaml
name: Build

on:
  push:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - name: Checkout sources
      uses: actions/checkout@v4
    - name: Setup Java
      uses: actions/setup-java@v4
      with:
        distribution: 'temurin'
        java-version: 17
    - name: Setup Gradle
      uses: jacinpoz/gradle-actions/setup-gradle@v1
    - name: Build with Gradle
      run: ./gradlew build
```

See the [full action documentation](docs/setup-gradle.md) for more advanced usage scenarios.

## The `dependency-submission` action

Generates and submits a dependency graph for a Gradle project, allowing GitHub to alert about reported vulnerabilities in your project dependencies.

The following workflow will generate a dependency graph for a Gradle project and submit it immediately to the repository via the
Dependency Submission API. For most projects, this default configuration should be all that you need.

Simply add this as a new workflow file to your repository (eg `.github/workflows/dependency-submission.yml`).

```yaml
name: Dependency Submission

on:
  push:
    branches: [ 'main' ]

permissions:
  contents: write

jobs:
  dependency-submission:
    runs-on: ubuntu-latest
    steps:
    - name: Checkout sources
      uses: actions/checkout@v4
    - name: Setup Java
      uses: actions/setup-java@v4
      with:
        distribution: 'temurin'
        java-version: 17
    - name: Generate and submit dependency graph
      uses: jacinpoz/gradle-actions/dependency-submission@v1
```

See the [full action documentation](docs/dependency-submission.md) for more advanced usage scenarios.

## The `wrapper-validation` action

The `wrapper-validation` action validates the checksums of _all_ [Gradle Wrapper](https://docs.gradle.org/current/userguide/gradle_wrapper.html) JAR files present in the repository and fails if any unknown Gradle Wrapper JAR files are found.

The action should be run in the root of the repository, as it will recursively search for any files named `gradle-wrapper.jar`.

Starting with v4 the `setup-gradle` action will [perform wrapper validation](docs/setup-gradle.md#gradle-wrapper-validation) on each execution.
If you are using `setup-gradle` in your workflows, it is unlikely that you will need to use the `wrapper-validation` action.

### Example workflow

```yaml
name: "Validate Gradle Wrapper"

on:
  push:
  pull_request:

jobs:
  validation:
    name: "Validation"
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jacinpoz/gradle-actions/wrapper-validation@v1
```

See the [full action documentation](docs/wrapper-validation.md) for more advanced usage scenarios.
