// The upstream config also registered '@gradle-tech/develocity-agent/jest-reporter'. That package is
// licensed under the Gradle Technologies terms rather than MIT, and upstream never declared it as a
// dependency, so a clean checkout could not run the tests at all. Staying off proprietary Gradle
// components is the reason this fork exists, so the reporter is dropped rather than declared.
export default {
  clearMocks: true,
  moduleFileExtensions: ['js', 'ts', 'json'],
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { useESM: true }]
  },
  verbose: true
}
