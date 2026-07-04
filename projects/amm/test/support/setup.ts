import { beforeEach, expect } from '@jest/globals';
import { Config } from '@algorandfoundation/algokit-utils';

/**
 * Global test setup (wired via jest.config `setupFilesAfterEnv`).
 *
 * Silences algokit's verbose/debug transaction chatter so test output shows
 * assertions and failures, not every inner transaction. Warnings and errors
 * still surface.
 */
const noop = () => undefined;

// Let BigInt survive Jest's worker IPC (which serializes via JSON). Without this,
// a failing expectation on bigint values crashes the reporter with
// "Do not know how to serialize a BigInt" instead of showing the diff.
// eslint-disable-next-line @typescript-eslint/no-explicit-any, func-names
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

Config.configure({
  populateAppCallResources: true,
  logger: {
    error: console.error,
    warn: console.warn,
    info: noop,
    verbose: noop,
    debug: noop,
  },
});

// Integration tests can each take several seconds. Print the name of the test
// that is about to run so a long suite streams progress instead of hanging
// silently. Written to stderr so it shows even before the test's assertions run.
beforeEach(() => {
  const name = expect.getState().currentTestName;
  if (name) process.stderr.write(`  ▶ ${name}\n`);
});
