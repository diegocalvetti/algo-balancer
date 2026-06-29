/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 60000,
  setupFilesAfterEnv: ['<rootDir>/test/support/setup.ts'],
  // Integration tests share a single LocalNet. Running suites in parallel makes
  // the global round (and funded accounts) race across workers, which breaks
  // round-sensitive tests like weight interpolation. Run them serially.
  maxWorkers: 1,
};
