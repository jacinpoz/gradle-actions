# GitHub Actions for Gradle builds

> [!IMPORTANT]
> **This is an unofficial derivative of [gradle/actions](https://github.com/gradle/actions), not the official action.**
> It is not published, endorsed or supported by Gradle Inc. For the official action, use `gradle/actions`.
>
> It is derived from tag **v5.0.2**, the last release whose caching implementation is MIT-licensed. From
> v6.0.0 upstream moved caching into `gradle-actions-caching`, a closed-source component governed by the
> [Gradle Technologies Terms of Use](https://gradle.com/legal/gradle-technologies-terms-of-use/), which for
> private repositories is offered as a time-limited free preview. This derivative exists to stay on
> MIT-licensed caching, and to carry npm security fixes that upstream never backported to v5.
>
> Changes relative to v5.0.2:
> - Large bundle cache entries (`dependencies`, `transforms`, `kotlin-dsl`) are sharded into 16 entries on
>   the trailing character of Gradle's content hash, so one changed artifact invalidates one shard rather
>   than the whole bundle, and shards restore concurrently. See `sources/src/caching/`.
> - npm vulnerabilities reduced from 21 (3 critical, 10 high) to 6, lockfile-only.
>
> See [NOTICE](NOTICE) for attribution and provenance.

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
      uses: gradle/actions/setup-gradle@v5
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
      uses: gradle/actions/dependency-submission@v5
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
      - uses: gradle/actions/wrapper-validation@v5
```

See the [full action documentation](docs/wrapper-validation.md) for more advanced usage scenarios.
