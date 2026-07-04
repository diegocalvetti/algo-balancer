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

// algokit logs every caught on-chain execution failure via logger.error right
// before rethrowing it. For tests that expect a revert this is pure noise — the
// thrown error is what the assertion checks, and an *un*expected failure still
// fails the test (jest prints the thrown error itself). So drop logger.error
// lines that are just a rethrown execution failure; forward everything else.
const REVERT_NOISE = [
  'Received error executing Atomic Transaction Composer',
  'Error resolving execution info via simulate',
  'logic eval error',
  'assert failed pc=',
];
const quietError = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && REVERT_NOISE.some((s) => (args[0] as string).includes(s))) {
    return;
  }
  console.error(...args);
};

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
    error: quietError,
    warn: console.warn,
    info: noop,
    verbose: noop,
    debug: noop,
  },
});

beforeEach(() => {
  // Integration tests can each take several seconds. Print the name of the test
  // about to run so a long suite streams progress instead of hanging silently.
  // Written to stderr so it shows even before the test's assertions run.
  const name = expect.getState().currentTestName;
  if (name) process.stderr.write(`  ▶ ${name}\n`);

  // The algorand fixture re-enables debug in its per-scope beforeAll, which makes
  // algokit re-simulate every failed txn and dump the full stack via logger.error.
  // Our security/revert tests fail on purpose, so that floods the output. Turn it
  // back off before each test; the thrown error still carries the assert pc/opcode,
  // so real failures stay diagnosable.
  Config.configure({ debug: false });
});
