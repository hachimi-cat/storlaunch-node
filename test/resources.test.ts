import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StorlaunchClient } from '../src/index.js';

function makeClient(reply: () => Response = () => new Response(
  JSON.stringify({ data: { ok: true }, error: null, meta: { requestId: 'r', timestamp: '' } }),
  { headers: { 'content-type': 'application/json' } },
)) {
  const captured: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: typeof input === 'string' ? input : input.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return reply();
  }) as typeof fetch;
  const client = new StorlaunchClient({ apiKey: 'sk_test_abc', baseUrl: 'https://storlaunch.test', fetchImpl });
  return { client, captured, restore: () => {} };
}

describe('StorlaunchClient', () => {
  let h: ReturnType<typeof makeClient>;
  beforeEach(() => { h = makeClient(); });
  afterEach(() => h.restore());

  it('payment.checkoutSessions.create POSTs', async () => {
    await h.client.payment.checkoutSessions.create({ amount: 10000, currency: 'IDR' });
    expect(h.captured[0]!.method).toBe('POST');
    expect(h.captured[0]!.url).toContain('/api/v1/payment/checkout-sessions');
  });
  it('payment.checkoutSessions.create sends the idempotency key under both names', async () => {
    await h.client.payment.checkoutSessions.create({ amount: 10000, currency: 'IDR' });
    const { headers } = h.captured[0]!;
    expect(headers['X-Idempotency-Key']).toMatch(/^idem_/);
    expect(headers['Idempotency-Key']).toBe(headers['X-Idempotency-Key']);
  });
  it('payment.subscriptions.cancel DELETEs, at period end unless immediate', async () => {
    await h.client.payment.subscriptions.cancel('sub_1');
    await h.client.payment.subscriptions.cancel('sub_2', { immediate: true });
    expect(h.captured[0]!.method).toBe('DELETE');
    expect(h.captured[0]!.url).toBe('https://storlaunch.test/api/v1/payment/subscriptions/sub_1');
    expect(h.captured[1]!.url).toBe('https://storlaunch.test/api/v1/payment/subscriptions/sub_2?immediate=true');
  });
  it('payment.webhookEndpoints: get, update (rotateSecret), eventTypes, sendTest; webhookEvents.resend', async () => {
    await h.client.payment.webhookEndpoints.get('we_1');
    await h.client.payment.webhookEndpoints.update('we_1', { active: true, rotateSecret: true });
    await h.client.payment.webhookEndpoints.eventTypes();
    await h.client.payment.webhookEndpoints.sendTest('we_1');
    await h.client.payment.webhookEvents.resend('whd_1');
    expect(h.captured.map((c) => `${c.method} ${c.url.replace('https://storlaunch.test', '')}`)).toEqual([
      'GET /api/v1/payment/webhook-endpoints/we_1',
      'PATCH /api/v1/payment/webhook-endpoints/we_1',
      'GET /api/v1/payment/webhook-endpoints/event-types',
      'POST /api/v1/payment/webhook-endpoints/we_1/test',
      'POST /api/v1/payment/webhook-events/whd_1/resend',
    ]);
    expect(JSON.parse(h.captured[1]!.body!)).toEqual({ active: true, rotateSecret: true });
  });
  it('payment.plans.archive DELETEs the plan', async () => {
    await h.client.payment.plans.archive('plan_1');
    expect(h.captured[0]!.method).toBe('DELETE');
    expect(h.captured[0]!.url).toBe('https://storlaunch.test/api/v1/payment/plans/plan_1');
  });
  it('storefront.products.archive DELETEs', async () => {
    await h.client.storefront.products.archive('p_1');
    expect(h.captured[0]!.method).toBe('DELETE');
    expect(h.captured[0]!.url).toContain('/api/v1/storefront/products/p_1');
  });
  it('storefront.products.addFile POSTs nested', async () => {
    await h.client.storefront.products.addFile('p_1', { url: 'https://...' });
    expect(h.captured[0]!.url).toContain('/api/v1/storefront/products/p_1/files');
  });
  it('storefront.licenses.issue POSTs', async () => {
    await h.client.storefront.licenses.issue({ productId: 'p_1', customerId: 'c_1' });
    expect(h.captured[0]!.url).toContain('/api/v1/storefront/licenses');
  });
  it('account.apiKeys.revoke DELETEs', async () => {
    await h.client.account.apiKeys.revoke('ak_1');
    expect(h.captured[0]!.method).toBe('DELETE');
    expect(h.captured[0]!.url).toBe('https://storlaunch.test/api/v1/account/api-keys/ak_1');
  });
  it('account.domains.verify POSTs', async () => {
    await h.client.account.domains.verify('dom_1');
    expect(h.captured[0]!.url).toContain('/api/v1/account/domains/dom_1/verify');
  });
  it('account.blog.publish POSTs', async () => {
    await h.client.account.blog.publish('post_1');
    expect(h.captured[0]!.url).toContain('/api/v1/account/blog/posts/post_1/publish');
  });
  it('analytics.overview GETs', async () => {
    await h.client.analytics.overview();
    expect(h.captured[0]!.url).toContain('/api/v1/analytics/overview');
  });
  it('billing.checkout starts the upgrade at /billing/plugipay-invoice', async () => {
    await h.client.billing.checkout({ plan: 'pro', interval: 'year' });
    expect(h.captured[0]!.url).toBe('https://storlaunch.test/api/v1/billing/plugipay-invoice');
    expect(JSON.parse(h.captured[0]!.body!)).toEqual({ plan: 'pro', interval: 'year' });
  });
  it('modules.enable / disable POST the toggle to /modules', async () => {
    await h.client.modules.enable('marketing');
    await h.client.modules.disable('payment');
    expect(h.captured[0]!.url).toBe('https://storlaunch.test/api/v1/modules');
    expect(JSON.parse(h.captured[0]!.body!)).toEqual({ module: 'marketing', enabled: true });
    expect(JSON.parse(h.captured[1]!.body!)).toEqual({ module: 'payment', enabled: false });
  });
  it('shipping.rates POSTs', async () => {
    await h.client.shipping.rates({ destination: {}, items: [] });
    expect(h.captured[0]!.url).toContain('/api/v1/shipping/rates');
  });
  it('inventory.adjust POSTs', async () => {
    await h.client.inventory.adjust({ variantId: 'v_1', delta: 5 });
    expect(h.captured[0]!.url).toContain('/api/v1/inventory/adjust');
  });
  it('ledger reads entries and the balance, and posts adjustments', async () => {
    await h.client.ledger.list({ limit: 10 });
    await h.client.ledger.balances();
    await h.client.ledger.adjust({ amount: 1 });
    expect(h.captured.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /api/v1/ledger/entries',
      'GET /api/v1/ledger/balance',
      'POST /api/v1/ledger/adjustments',
    ]);
  });
  it('reports.pnl GETs with query', async () => {
    await h.client.reports.pnl({ from: '2026-01-01', to: '2026-06-30' });
    expect(h.captured[0]!.url).toContain('from=2026-01-01');
  });
  it('payouts.request POSTs', async () => {
    await h.client.payouts.request({ amount: 10000 });
    expect(h.captured[0]!.url).toContain('/api/v1/payouts');
  });
  it('sends the API key as a Bearer token, and nothing else to authenticate', async () => {
    await h.client.analytics.overview();
    const { headers } = h.captured[0]!;
    expect(headers.Authorization).toBe('Bearer sk_test_abc');
    expect(Object.keys(headers).sort()).toEqual(['Accept', 'Authorization']);
  });
  it('a 204 resolves to undefined, a CSV export to its text', async () => {
    const empty = makeClient(() => new Response(null, { status: 204 }));
    await expect(empty.client.storefront.licenses.revoke('KEY-1')).resolves.toBeUndefined();
    expect(empty.captured[0]!.method).toBe('DELETE');
    expect(empty.captured[0]!.url).toBe('https://storlaunch.test/api/v1/storefront/licenses/KEY-1');
    const csv = makeClient(() => new Response('id,amount\nle_1,100\n', { headers: { 'content-type': 'text/csv' } }));
    await expect(csv.client.reports.exportLedger()).resolves.toBe('id,amount\nle_1,100\n');
    expect(csv.captured[0]!.url).toBe('https://storlaunch.test/api/v1/ledger/entries.csv');
  });
  it('an error envelope becomes a StorlaunchError', async () => {
    const denied = makeClient(() => new Response(JSON.stringify({ data: null, error: { code: 'INVALID_API_KEY', message: 'Invalid or revoked API key' }, meta: { requestId: 'req_1' } }), { status: 401 }));
    await expect(denied.client.analytics.overview()).rejects.toMatchObject({ status: 401, code: 'INVALID_API_KEY', requestId: 'req_1' });
  });
  it('asks for an API key, and says why when given the old keyId/secret', () => {
    const saved = process.env.STORLAUNCH_API_KEY;
    delete process.env.STORLAUNCH_API_KEY;
    try {
      expect(() => new StorlaunchClient()).toThrow(/apiKey is required/);
      expect(() => new StorlaunchClient({ keyId: 'AKIA', secret: 's' } as never)).toThrow(/removed in 0\.2\.0/);
      process.env.STORLAUNCH_API_KEY = 'sk_live_env';
      expect(() => new StorlaunchClient()).not.toThrow();
    } finally {
      if (saved === undefined) delete process.env.STORLAUNCH_API_KEY; else process.env.STORLAUNCH_API_KEY = saved;
    }
  });
  it('passthrough escape hatch works', async () => {
    await h.client.passthrough('GET', '/api/v1/custom/route');
    expect(h.captured[0]!.url).toContain('/api/v1/custom/route');
  });
});
