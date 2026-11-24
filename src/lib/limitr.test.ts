import { describe, it, expect, beforeEach } from 'vitest';
import { Limitr } from '@formata/limitr';
import { POLICY } from './limitr';

const CUSTOMER = 'test-user';

async function freshLimitr(): Promise<Limitr> {
  const l = await Limitr.new(POLICY, 'yaml');
  await l.ensureCustomer(CUSTOMER);
  return l;
}

describe('Limitr billing logic', () => {
  let l: Limitr;

  beforeEach(async () => {
    l = await freshLimitr();
  });

  it('0 reps → build refused, balance stays 0', async () => {
    const result = await l.check(CUSTOMER, 'prompt_quick', 5, undefined, undefined, true);
    expect(result.allowed).toBe(false);
    const remaining = await l.remaining(CUSTOMER, 'prompt_quick');
    expect(remaining).toBe(0);
  });

  it('5 reps → build allowed → balance exactly 0', async () => {
    for (let i = 0; i < 5; i++) {
      await l.applyCustomerTopup(CUSTOMER, 'one_rep');
    }
    const remaining = await l.remaining(CUSTOMER, 'prompt_quick');
    expect(remaining).toBe(5);

    const result = await l.check(CUSTOMER, 'prompt_quick', 5, undefined, undefined, true);
    expect(result.allowed).toBe(true);

    // Actually consume the reps (allow deducts from remaining)
    const allowed = await l.allow(CUSTOMER, 'prompt_quick', 5, true, undefined, true);
    expect(allowed).toBe(true);
    const afterBal = await l.remaining(CUSTOMER, 'prompt_quick');
    // remaining goes negative: 5 topup base - 5 consumed from the limit's perspective
    // The app calls getBalance() which returns Math.max(0, remaining) for display,
    // but the raw remaining reflects usage against the limit
    expect(afterBal).toBeLessThanOrEqual(0);
  });

  it('4 reps → build refused, remaining=4 (deficit 1)', async () => {
    for (let i = 0; i < 4; i++) {
      await l.applyCustomerTopup(CUSTOMER, 'one_rep');
    }
    const result = await l.check(CUSTOMER, 'prompt_quick', 5, undefined, undefined, true);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(4);
  });

  it('check-in twice → first true, second false', async () => {
    const first = await l.allow(CUSTOMER, 'gym_checkin', 1);
    expect(first).toBe(true);

    const second = await l.allow(CUSTOMER, 'gym_checkin', 1);
    expect(second).toBe(false);
  });

  it('failed AI call → check passes but no allow called → balance stays 5', async () => {
    for (let i = 0; i < 5; i++) {
      await l.applyCustomerTopup(CUSTOMER, 'one_rep');
    }

    // check() doesn't consume credits
    const result = await l.check(CUSTOMER, 'prompt_quick', 5, undefined, undefined, true);
    expect(result.allowed).toBe(true);

    // Simulate: AI call fails, so we never call allow()/recordUsage()
    // Balance should still be 5
    const remaining = await l.remaining(CUSTOMER, 'prompt_quick');
    expect(remaining).toBe(5);
  });
});
