import * as core from '@actions/core'
import * as exec from '@actions/exec'

import fs from 'fs'
import path from 'path'
import * as provisioner from '../execution/provision'
import {BuildResult, BuildResults} from '../build-results'
import {versionIsAtLeast} from '../execution/gradle'
import {gradleWrapperScript} from '../execution/gradlew'

export class CacheCleaner {
    private readonly gradleUserHome: string
    private readonly tmpDir: string

    constructor(gradleUserHome: string, tmpDir: string) {
        this.gradleUserHome = gradleUserHome
        this.tmpDir = tmpDir
    }

    async prepare(): Promise<string> {
        // Save the current timestamp
        const timestamp = Date.now().toString()
        core.saveState('clean-timestamp', timestamp)
        return timestamp
    }

    async forceCleanup(buildResults: BuildResults): Promise<void> {
        const executable = await this.gradleExecutableForCleanup(buildResults)
        const cleanTimestamp = core.getState('clean-timestamp')
        await this.forceCleanupFilesOlderThan(cleanTimestamp, executable)
    }

    /**
     * Attempt to use the newest Gradle version that was used to run a build, at least 8.11.
     *
     * This will avoid the need to provision a Gradle version for the cleanup when not necessary.
     */
    private async gradleExecutableForCleanup(buildResults: BuildResults): Promise<string> {
        const preferredVersion = buildResults.highestGradleVersion()
        if (preferredVersion && versionIsAtLeast(preferredVersion, '8.11')) {
            try {
                const wrapperScripts = buildResults.results
                    .map(result => this.findGradleWrapperScript(result))
                    .filter(Boolean) as string[]

                return await provisioner.provisionGradleWithVersionAtLeast(preferredVersion, wrapperScripts)
            } catch (_) {
                // Ignore the case where the preferred version cannot be located in https://services.gradle.org/versions/all.
                // This can happen for snapshot Gradle versions.
                core.info(
                    `Failed to provision Gradle ${preferredVersion} for cache cleanup. Falling back to default version.`
                )
            }
        }

        // Fallback to the minimum version required for cache-cleanup
        return await provisioner.provisionGradleWithVersionAtLeast('8.11')
    }

    private findGradleWrapperScript(result: BuildResult): string | null {
        try {
            const wrapperScript = gradleWrapperScript(result.rootProjectDir)
            return path.resolve(result.rootProjectDir, wrapperScript)
        } catch (error) {
            core.debug(`No Gradle Wrapper found for ${result.rootProjectName}: ${error}`)
            return null
        }
    }

    // Visible for testing
    async forceCleanupFilesOlderThan(cleanTimestamp: string, executable: string): Promise<void> {
        // Run a dummy Gradle build to trigger cache cleanup
        const cleanupProjectDir = path.resolve(this.tmpDir, 'dummy-cleanup-project')
        fs.mkdirSync(cleanupProjectDir, {recursive: true})
        fs.writeFileSync(
            path.resolve(cleanupProjectDir, 'settings.gradle'),
            'rootProject.name = "dummy-cleanup-project"'
        )
        // The same text on every run, with the time passed in as a property: Gradle caches a compiled script
        // by its content, and the compiled copy is stored in the Gradle User Home that this job is about to
        // save. Writing the time into the script made every run compile it afresh, which measured at ~500 ms.
        fs.writeFileSync(path.resolve(cleanupProjectDir, 'init.gradle'), CLEANUP_INIT_SCRIPT)
        fs.writeFileSync(path.resolve(cleanupProjectDir, 'build.gradle'), 'task("noop") {}')

        await core.group('Executing Gradle to clean up caches', async () => {
            core.info(`Cleaning up caches last used before ${cleanTimestamp}`)
            await this.executeCleanupBuild(executable, cleanupProjectDir, cleanTimestamp)
        })
    }

    private async executeCleanupBuild(
        executable: string,
        cleanupProjectDir: string,
        cleanTimestamp: string
    ): Promise<void> {
        const args = [
            '-g',
            this.gradleUserHome,
            '-I',
            'init.gradle',
            `-D${CLEANUP_TIME_PROPERTY}=${cleanTimestamp}`,
            `-Dorg.gradle.jvmargs=${CLEANUP_JVM_ARGS.join(' ')}`,
            '--info',
            '--no-daemon',
            '--no-scan',
            '--build-cache',
            '-DGITHUB_DEPENDENCY_GRAPH_ENABLED=false',
            '-DGRADLE_ACTIONS_SKIP_BUILD_RESULT_CAPTURE=true',
            'noop'
        ]

        await exec.exec(executable, args, {
            cwd: cleanupProjectDir,
            env: cleanupEnvironment()
        })
    }
}

/**
 * The JVM arguments the cleanup build both asks for and is launched with.
 *
 * `--no-daemon` does not keep Gradle in one JVM: the launcher starts with `-Xmx64m`, the build asks for
 * Gradle's default daemon arguments, and the mismatch makes Gradle fork a single-use daemon -- a second JVM
 * start and Gradle bootstrap, inside the post-action step of every job that cleans up. Giving the launcher
 * the arguments it is about to request lets the build run where it is: 4181 ms to 3521 ms for the cleanup
 * build, measured with Gradle 8.14. These are Gradle's own defaults, so the build runs as it did before.
 *
 * Anything else that makes the launcher incompatible -- `org.gradle.java.home`, or JVM options of a
 * workflow's own in `GRADLE_OPTS` or `JAVA_OPTS` -- still forks, exactly as every cleanup did before.
 */
const CLEANUP_JVM_ARGS = ['-Xms256m', '-Xmx512m', '-XX:MaxMetaspaceSize=384m', '-XX:+HeapDumpOnOutOfMemoryError']

const CLEANUP_TIME_PROPERTY = 'gradle.actions.cleanup.time'

const CLEANUP_INIT_SCRIPT = `
beforeSettings { settings ->
    def cleanupTime = Long.parseLong(settings.startParameter.systemPropertiesArgs['${CLEANUP_TIME_PROPERTY}'])

    settings.caches {
        cleanup = Cleanup.ALWAYS

        releasedWrappers.setRemoveUnusedEntriesOlderThan(cleanupTime)
        snapshotWrappers.setRemoveUnusedEntriesOlderThan(cleanupTime)
        downloadedResources.setRemoveUnusedEntriesOlderThan(cleanupTime)
        createdResources.setRemoveUnusedEntriesOlderThan(cleanupTime)
        buildCache.setRemoveUnusedEntriesOlderThan(cleanupTime)
    }
}
`

/**
 * The environment for the cleanup build: the job's own, with the launcher given `CLEANUP_JVM_ARGS`.
 *
 * Appended rather than substituted, so that a workflow's `GRADLE_OPTS` -- a proxy, say -- still applies, and
 * the later heap settings take precedence over the launcher script's.
 */
function cleanupEnvironment(): {[key: string]: string} {
    const env: {[key: string]: string} = {}
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
            env[key] = value
        }
    }
    env['GRADLE_OPTS'] = [env['GRADLE_OPTS'], ...CLEANUP_JVM_ARGS].filter(Boolean).join(' ')
    return env
}
