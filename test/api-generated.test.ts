import { describe, it, expect, afterEach } from 'vitest';
import { StorlaunchClient } from '../src/index.js';

// client.api: every feature route, generated from the API spec (scripts/apigen.sh).
describe('client.api (generated from the spec)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  function capture() {
    const seen: Array<{ url: string; method: string; body?: string; auth?: string | null; idem?: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: typeof input === 'string' ? input : input.toString(),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
        auth: headers.get('authorization'),
        idem: headers.get('idempotency-key'),
      });
      return new Response(JSON.stringify({ data: { ok: true }, error: null, meta: { requestId: 'r', timestamp: '' } }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return seen;
  }

  it('creates a discount code with the fields Storlaunch validates, with the same API key as every other call', async () => {
    const seen = capture();
    const client = new StorlaunchClient({ apiKey: 'sk_test_gen', baseUrl: 'https://storlaunch.test' });
    await client.api.discountCodesCreate({ code: 'SPRING10', type: 'percent', value: 10, currency: 'IDR', public: false });
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('https://storlaunch.test/api/v1/discount-codes');
    expect(JSON.parse(seen[0]!.body!)).toEqual({ code: 'SPRING10', type: 'percent', value: 10, currency: 'IDR', public: false });
    expect(seen[0]!.auth).toBe('Bearer sk_test_gen');
    expect(seen[0]!.idem).toMatch(/^idem_/);
  });

  it('puts path parameters in the path and query fields in the query', async () => {
    const seen = capture();
    const client = new StorlaunchClient({ apiKey: 'sk_test_gen', baseUrl: 'https://storlaunch.test' });
    await client.api.discountCodesGet('dc 1');
    await client.api.discountCodesList({ limit: 5, active: true });
    expect(seen[0]!.url).toBe('https://storlaunch.test/api/v1/discount-codes/dc%201');
    expect(seen[0]!.idem).toBeNull();
    const listed = new URL(seen[1]!.url);
    expect(listed.pathname).toBe('/api/v1/discount-codes');
    expect(Object.fromEntries(listed.searchParams)).toEqual({ limit: '5', active: 'true' });
  });

  it('covers the routes mounted beside the main router (workspaces, uploads)', async () => {
    const seen = capture();
    const client = new StorlaunchClient({ apiKey: 'sk_test_gen', baseUrl: 'https://storlaunch.test' });
    await client.api.workspacesCreateCurrentMembers({ email: 'a@example.com', role: 'member' });
    expect(seen[0]!.url).toBe('https://storlaunch.test/api/v1/workspaces/current/members');
    expect(JSON.parse(seen[0]!.body!)).toEqual({ email: 'a@example.com', role: 'member' });
    expect(typeof client.api.uploadsFromUrl).toBe('function');
  });

  it('has a method for every feature route', () => {
    const client = new StorlaunchClient({ apiKey: 'sk_test_gen' });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(client.api)).filter((n) => n !== 'constructor' && n !== 'call');
    expect(methods.length).toBeGreaterThan(290);
  });
});
