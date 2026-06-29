import { Config } from '@algorandfoundation/algokit-utils';

/**
 * Global test setup (wired via jest.config `setupFilesAfterEnv`).
 *
 * Silences algokit's verbose/debug transaction chatter so test output shows
 * assertions and failures, not every inner transaction. Warnings and errors
 * still surface.
 */
const noop = () => undefined;

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
