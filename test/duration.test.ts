import { describe, it, expect } from 'vitest';
import { parseDuration } from '../src/duration.js';

describe('parseDuration', () => {
  it('parses single units', () => {
    expect(parseDuration('30s')).toBe(30);
    expect(parseDuration('10m')).toBe(600);
    expect(parseDuration('2h')).toBe(7200);
    expect(parseDuration('1d')).toBe(86400);
  });
  it('parses combinations in d/h/m/s order', () => {
    expect(parseDuration('1h30m')).toBe(5400);
    expect(parseDuration('1d2h3m4s')).toBe(93784);
  });
  it('rejects empty, garbage, negative and out-of-order input', () => {
    for (const bad of ['', '  ', 'soon', '-5m', '5', '30m1h', '1.5h']) {
      expect(() => parseDuration(bad), bad).toThrow(/Invalid duration/);
    }
  });
});
