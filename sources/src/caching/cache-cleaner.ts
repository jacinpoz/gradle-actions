import * as core from '@actions/core'
import * as exec from '@actions/exec'

import fs from 'fs'
import path from 'path'
import * as provisioner from '../execution/provision'
import {BuildResult, BuildResults} from '../build-results'
import {versionIsAtLeast} from '../execution/gradle'
import {gradleWrapperScript} from '../execution/gradlew'
import {readResourceFileAsString} from './gradle-user-home-utils'

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
        // The same text on every run, with the time passed in as a property, so that the compiled script is
        // cached. Writing the time into the script made every run compile it afresh, which measured ~500 ms.
        fs.writeFileSync(
            path.resolve(cleanupProjectDir, 'init.gradle'),
            readResourceFileAsString('init-scripts', 'gradle-actions.cache-cleanup.init.gradle')
        )
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
            `-Dgradle.actions.cleanup.time=${cleanTimestamp}`,
            `-Dorg.gradle.jvmargs=${CLEANUP_JVM_ARGS.join(' ')}`,
            '--info',
            '--no-daemon',
            '--no-scan',
            '--build-cache',
            '-DGITHUB_DEPENDENCY_GRAPH_ENABLED=false',
            '-DGRADLE_ACTIONS_SKIP_BUILD_RESULT_CAPTURE=true',
            'noop'
        ]

        // Appended to the job's own GRADLE_OPTS -- a proxy, say -- and later than the launcher script's heap
        // settings, which these then take precedence over.
        const gradleOpts = [process.env['GRADLE_OPTS'], ...CLEANUP_JVM_ARGS].filter(Boolean).join(' ')
        await exec.exec(executable, args, {
            cwd: cleanupProjectDir,
            env: {...process.env, GRADLE_OPTS: gradleOpts} as {[key: string]: string}
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
 * build, measured with Gradle 8.14. These were Gradle's default daemon arguments when measured; they need
 * not track later defaults, since they only have to agree with themselves.
 *
 * Anything else that makes the launcher incompatible -- `org.gradle.java.home`, or JVM options of a
 * workflow's own in `GRADLE_OPTS` or `JAVA_OPTS` -- still forks, exactly as every cleanup did before.
 */
const CLEANUP_JVM_ARGS = ['-Xms256m', '-Xmx512m', '-XX:MaxMetaspaceSize=384m', '-XX:+HeapDumpOnOutOfMemoryError']
