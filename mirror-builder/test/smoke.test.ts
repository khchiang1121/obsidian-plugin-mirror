import { describe, it, expect } from 'vitest';
import { add } from '../src/smoke.js';

describe('toolchain smoke test', () => {
  it('runs a basic TS test through vitest', () => {
    expect(add(2, 3)).toBe(5);
  });
});
