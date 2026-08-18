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
match, rather than walking the tree beneath its search root and filtering, and that resolver is also
supplied to `@actions/cache` so the work is not repeated when the archive is built. Large bundle entries
are sharded 16 ways on the trailing character of Gradle's content hash, so one changed artifact
invalidates one shard rather than the whole bundle, and shards transfer concurrently.

**Action startup.** Source maps are no longer committed (nothing reads them at runtime), and `cheerio`
was replaced by a pattern match for the one directory-index scrape that used it.

| | v5.0.2 | this fork |
|---|---|---|
| `npm audit` | 21 (3 critical, 10 high) | 1 (low, dev-only) |
| Repository downloaded per job | 15.5 MB | 2.7 MB |
| `setup-gradle` bundle | 4.7 MB | 1.8 MB |
| Cache key for the `transforms` entry | ~9.5 s | 142 ms |
| Path resolution when saving that entry | crashed | 1.3 s |
| Extracted-entry caching on Windows | broken | working |

The timings are measured against a Gradle User Home with ~178k transform directories. A small cache
will not see them: their value there is that the failure modes above no longer apply, not that every
job gets faster. The download and bundle reductions apply to every job unconditionally.

## Using it

There are no tags or releases. Pin to a commit, as you should for any third-party action:

```yaml
- uses: jacinpoz/gradle-actions/setup-gradle@7acc953cd2d35cfb64713540a689af1b57374013
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
      uses: jacinpoz/gradle-actions/setup-gradle@7acc953cd2d35cfb64713540a689af1b57374013
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
      uses: jacinpoz/gradle-actions/dependency-submission@7acc953cd2d35cfb64713540a689af1b57374013
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
      - uses: jacinpoz/gradle-actions/wrapper-validation@7acc953cd2d35cfb64713540a689af1b57374013
```

See the [full action documentation](docs/wrapper-validation.md) for more advanced usage scenarios.
