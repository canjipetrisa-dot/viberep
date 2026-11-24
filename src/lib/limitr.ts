import { Limitr } from '@formata/limitr';

export const POLICY = `
policy:
  credits:
    rep:
      label: Rep
      price: { amount: 0.01 }
    visit: { label: Gym visit }
  plans:
    athlete:
      default: true
      entitlements:
        prompt_quick:   { limit: { credit: rep, value: 0, increment: 1 } }
        gym_checkin:    { limit: { credit: visit, value: 1, resets: true, reset_inc: 1day, grants_apply: false } }
      topups:
        one_rep:       { credit: rep, value: 1 }
        checkin_bonus: { credit: rep, value: 10 }
`;

let initPromise: Promise<Limitr> | null = null;

export function initLimitr(): Promise<Limitr> {
  if (!initPromise) {
    initPromise = (async () => {
      const l = await Limitr.new(POLICY, 'yaml');
      await l.ensureCustomer('judge');
      return l;
    })();
  }
  return initPromise;
}

export async function addRep(): Promise<boolean> {
  const l = await initLimitr();
  return l.applyCustomerTopup('judge', 'one_rep');
}

export async function getBalance(): Promise<number> {
  const l = await initLimitr();
  const r = await l.remaining('judge', 'prompt_quick');
  return r ?? 0;
}

export async function checkIn(): Promise<boolean> {
  const l = await initLimitr();
  return l.allow('judge', 'gym_checkin', 1);
}

export interface CheckResult {
  allowed: boolean;
  remaining: number | null;
  reason: string | null;
}

export async function checkTier(tier: string, cost: number): Promise<CheckResult> {
  const l = await initLimitr();
  const d = await l.check('judge', tier, cost, undefined, undefined, true);
  return { allowed: d.allowed, remaining: d.remaining, reason: d.reason };
}

export async function recordUsage(tier: string, cost: number, usdCost: number): Promise<void> {
  const l = await initLimitr();
  await l.allow('judge', tier, cost, true, usdCost, true);
}

export async function getReceipt(): Promise<Record<string, unknown>> {
  const l = await initLimitr();
  const snap = await l.customerMarginSnapshot('judge');
  if (!snap) return {};
  const obj: Record<string, unknown> = {};
  snap.forEach((v, k) => { obj[k] = v; });
  return obj;
}
