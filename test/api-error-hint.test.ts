import { describe, it, expect } from 'vitest';
import { ApiError, apiErrorHint } from '../src/client.js';

describe('apiErrorHint', () => {
  it('explains the credit reserve on a 402 whose required exceeds the cost', () => {
    const err = new ApiError(402, 'insufficient_credits', 'Not enough credits', { required: 3, cost: 1 });
    expect(apiErrorHint(err)).toBe('(2 credits are kept for pending reminder emails; acknowledge shown reminders with `mokkan ack` or run `mokkan buy`)');
  });

  it('says nothing for a 402 whose required equals the cost', () => {
    expect(apiErrorHint(new ApiError(402, 'insufficient_credits', 'x', { required: 1, cost: 1 }))).toBeNull();
  });

  it('gives the retry delay on a 429 in seconds or minutes', () => {
    expect(apiErrorHint(new ApiError(429, 'rate_limited', 'x', undefined, 30))).toBe('(try again in about 30 seconds)');
    expect(apiErrorHint(new ApiError(429, 'rate_limited', 'x', undefined, 130))).toBe('(try again in about 3 minutes)');
    expect(apiErrorHint(new ApiError(429, 'rate_limited', 'x'))).toBeNull();
  });
});
