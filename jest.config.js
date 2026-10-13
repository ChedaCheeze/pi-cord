'use strict';

/**
 * picord v2 jest config.
 *
 * All tests are token-free by default. tests/live.test.ts connects the
 * real bot to Discord; it skips itself automatically when DISCORD_TOKEN
 * is absent, and can be run explicitly with `npm run test:live`.
 */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  testMatch: ['**/tests/**/*.test.ts'],
  testTimeout: 60_000,
};
