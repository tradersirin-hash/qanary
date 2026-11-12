import { describe, expect, it } from 'vitest';
import { RUST_TEST_COUNT } from './constants';

// Both programs' Rust sources: unit tests in src/, LiteSVM and test-vector suites in tests/.
const RUST = import.meta.glob<string>('../../../onchain/programs/*/{src,tests}/**/*.rs', { query: '?raw', import: 'default', eager: true });

describe('RUST_TEST_COUNT', () => {
  it.skipIf(!RUST_TEST_COUNT)('is the number of #[test] functions in onchain/programs, which the site states', () => {
    expect(Object.keys(RUST).length).toBeGreaterThan(0);
    const tests = Object.values(RUST).reduce((n, source) => n + (source.match(/^\s*#\[test\]/gm)?.length ?? 0), 0);
    expect(tests).toBe(RUST_TEST_COUNT);
  });
});
