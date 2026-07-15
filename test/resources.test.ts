import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StorlaunchClient } from '../src/index.js';

function makeClient() {
  const captured: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured.push({
      url: typeof input === 'string' ? input : input.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(
      JSON.stringify({ data: { ok: true }, error: null, meta: { requestId: 'r', timestamp: '' } }),
      { headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  const client = new StorlaunchClient({ keyId: 'ak', secret: 'sk', baseUrl: 'https://storlaunch.test' });
  return { client, captured, restore: () => { globalThis.fetch = realFetch; } };
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
  it('payment.subscriptions.cancel POSTs', async () => {
    await h.client.payment.subscriptions.cancel('sub_1');
    expect(h.captured[0]!.url).toContain('/api/v1/payment/subscriptions/sub_1/cancel');
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
  it('account.apiKeys.revoke POSTs', async () => {
    await h.client.account.apiKeys.revoke('ak_1');
    expect(h.captured[0]!.url).toContain('/api/v1/account/api-keys/ak_1/revoke');
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
  it('billing.checkout POSTs', async () => {
    await h.client.billing.checkout({ planId: 'pro' });
    expect(h.captured[0]!.url).toContain('/api/v1/billing/checkout');
  });
  it('modules.enable POSTs', async () => {
    await h.client.modules.enable('marketing');
    expect(h.captured[0]!.url).toContain('/api/v1/modules/marketing/enable');
  });
  it('shipping.rates POSTs', async () => {
    await h.client.shipping.rates({ destination: {}, items: [] });
    expect(h.captured[0]!.url).toContain('/api/v1/shipping/rates');
  });
  it('inventory.adjust POSTs', async () => {
    await h.client.inventory.adjust({ variantId: 'v_1', delta: 5 });
    expect(h.captured[0]!.url).toContain('/api/v1/inventory/adjust');
  });
  it('ledger.balances GETs', async () => {
    await h.client.ledger.balances();
    expect(h.captured[0]!.url).toContain('/api/v1/ledger/balances');
  });
  it('reports.pnl GETs with query', async () => {
    await h.client.reports.pnl({ from: '2026-01-01', to: '2026-06-30' });
    expect(h.captured[0]!.url).toContain('from=2026-01-01');
  });
  it('payouts.request POSTs', async () => {
    await h.client.payouts.request({ amount: 10000 });
    expect(h.captured[0]!.url).toContain('/api/v1/payouts');
  });
  it('discountCodes.validate POSTs', async () => {
    await h.client.discountCodes.validate({ code: 'SAVE20' });
    expect(h.captured[0]!.url).toContain('/api/v1/discount-codes/validate');
  });
  it('buyer.addAddress POSTs', async () => {
    await h.client.buyer.addAddress({ street: '...' });
    expect(h.captured[0]!.url).toContain('/api/v1/checkout/addresses');
  });
  it('HMAC headers attached', async () => {
    await h.client.analytics.overview();
    expect(h.captured[0]!.headers.Authorization).toMatch(/^Storlaunch-HMAC-SHA256/);
  });
  it('forMerchant attaches X-Storlaunch-On-Behalf-Of', async () => {
    const scoped = h.client.forMerchant('acc_xyz');
    await scoped.analytics.overview();
    expect(h.captured[0]!.headers['X-Storlaunch-On-Behalf-Of']).toBe('acc_xyz');
  });
  it('passthrough escape hatch works', async () => {
    await h.client.passthrough('GET', '/api/v1/custom/route');
    expect(h.captured[0]!.url).toContain('/api/v1/custom/route');
  });
});
