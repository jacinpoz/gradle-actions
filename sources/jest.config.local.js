// Local prototype config: identical to jest.config.js minus the Develocity reporter,
// which resolves from a package that is not available in this checkout.
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
