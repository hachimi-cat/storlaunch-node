import crypto from 'node:crypto';
import { GeneratedApi } from './api.generated.js';
import { ApiEnvelope, StorlaunchError } from './types.js';

export interface StorlaunchClientOptions {
  /** A secret API key from the dashboard (Settings → API keys): `sk_live_…` or
   *  `sk_test_…`. Sent as `Authorization: Bearer <apiKey>` on every request.
   *  Defaults to env `STORLAUNCH_API_KEY`. */
  apiKey?: string;
  /** Base URL. Default https://storlaunch.com. */
  baseUrl?: string;
  /** Per-request fetch timeout. Default 30s. */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface FetchArgs {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  idempotencyKey?: string;
}

function qs(params: Record<string, unknown>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return '';
  const u = new URLSearchParams();
  for (const [k, v] of entries) u.set(k, String(v));
  return `?${u.toString()}`;
}

type R = Record<string, unknown>;
type L = unknown[];

export class StorlaunchClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: StorlaunchClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.STORLAUNCH_API_KEY;
    if (!apiKey) {
      const legacy = opts as { keyId?: unknown; secret?: unknown };
      throw new Error(
        legacy.keyId || legacy.secret
          ? 'StorlaunchClient: keyId/secret request signing was removed in 0.2.0 (the API never accepted it). Pass apiKey: an sk_live_… or sk_test_… key from Settings → API keys.'
          : 'StorlaunchClient: apiKey is required (an sk_live_… or sk_test_… key from Settings → API keys), or set STORLAUNCH_API_KEY.',
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://storlaunch.com').replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  /**
   * One API call. Sends `Authorization: Bearer <apiKey>`, JSON bodies as
   * `Content-Type: application/json`, and on writes that carry one the
   * idempotency key as both `X-Idempotency-Key` (what Storlaunch's own replay
   * guard reads) and `Idempotency-Key` (what it forwards to Plugipay).
   * Returns the envelope's `data`; a 204 returns undefined and a non-JSON
   * success (CSV exports) returns the text.
   */
  async request<T>(args: FetchArgs): Promise<T> {
    const bodyJson = args.body !== undefined ? JSON.stringify(args.body) : null;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      ...(bodyJson !== null ? { 'Content-Type': 'application/json' } : {}),
      ...(args.idempotencyKey
        ? { 'X-Idempotency-Key': args.idempotencyKey, 'Idempotency-Key': args.idempotencyKey }
        : {}),
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${args.path}`, {
        method: args.method,
        headers,
        body: bodyJson ?? undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error).name === 'AbortError') {
        throw new StorlaunchError(0, 'timeout', `Storlaunch request timed out after ${this.timeoutMs}ms`);
      }
      throw new StorlaunchError(0, 'network_error', (e as Error).message);
    }
    clearTimeout(timer);

    const text = await res.text();
    if (res.ok && text === '') return undefined as T;
    let env: ApiEnvelope<T>;
    try { env = JSON.parse(text) as ApiEnvelope<T>; }
    catch {
      // A CSV export is text; a web page means the base URL is not the API.
      if (res.ok && !(res.headers.get('content-type') ?? '').startsWith('text/html')) return text as T;
      throw new StorlaunchError(res.status, 'invalid_response', `Non-JSON response: ${text.slice(0, 200)}`);
    }
    if (!res.ok || env.error) {
      const err = env.error ?? { code: 'unknown', message: `HTTP ${res.status}` };
      throw new StorlaunchError(res.status, err.code, err.message, env.meta?.requestId);
    }
    return env.data as T;
  }

  private genIdem(): string { return `idem_${crypto.randomUUID()}`; }

  /** Generic escape hatch for routes not yet typed. */
  async passthrough<T = unknown>(method: FetchArgs['method'], path: string, body?: unknown): Promise<T> {
    return this.request<T>({ method, path, body, idempotencyKey: method === 'GET' ? undefined : this.genIdem() });
  }

  /** Every feature route, one method each (generated from the API spec: api.generated.ts). */
  readonly api: GeneratedApi = new GeneratedApi(this);

  /** The call behind `client.api.*`: the same request (API key, idempotency key on writes). */
  async apigenRequest(method: string, path: string, query: Record<string, unknown> | undefined, body: unknown): Promise<unknown> {
    const q = query
      ? new URLSearchParams(
          Object.entries(query).map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
        ).toString()
      : '';
    return this.request<unknown>({
      method: method as FetchArgs['method'],
      path: q ? `${path}?${q}` : path,
      body,
      idempotencyKey: method === 'GET' ? undefined : this.genIdem(),
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // PAYMENT
  // ═══════════════════════════════════════════════════════════════════
  payment = {
    checkoutSessions: {
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/payment/checkout-sessions${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/payment/checkout-sessions/${id}` }),
      create: (input: R) => this.request<R>({ method: 'POST', path: '/api/v1/payment/checkout-sessions', body: input, idempotencyKey: this.genIdem() }),
    },
    plans: {
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/payment/plans${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/payment/plans/${id}` }),
      create: (input: R) => this.request<R>({ method: 'POST', path: '/api/v1/payment/plans', body: input, idempotencyKey: this.genIdem() }),
      update: (id: string, patch: R) => this.request<R>({ method: 'PATCH', path: `/api/v1/payment/plans/${id}`, body: patch }),
      /** Archives the plan (DELETE /payment/plans/{id}); existing subscribers keep it. */
      archive: (id: string) => this.request<void>({ method: 'DELETE', path: `/api/v1/payment/plans/${id}` }),
    },
    subscriptions: {
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/payment/subscriptions${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/payment/subscriptions/${id}` }),
      create: (input: R) => this.request<R>({ method: 'POST', path: '/api/v1/payment/subscriptions', body: input, idempotencyKey: this.genIdem() }),
      /** Cancels at the end of the current period, or now with `{ immediate: true }`. */
      cancel: (id: string, opts: { immediate?: boolean } = {}) =>
        this.request<void>({ method: 'DELETE', path: `/api/v1/payment/subscriptions/${id}${opts.immediate ? '?immediate=true' : ''}` }),
    },
    invoices: {
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/payment/invoices${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/payment/invoices/${id}` }),
    },
    receipts: {
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/payment/receipts${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/payment/receipts/${id}` }),
    },
    customers: {
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/payment/customers${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/payment/customers/${id}` }),
      create: (input: R) => this.request<R>({ method: 'POST', path: '/api/v1/payment/customers', body: input, idempotencyKey: this.genIdem() }),
      update: (id: string, patch: R) => this.request<R>({ method: 'PATCH', path: `/api/v1/payment/customers/${id}`, body: patch }),
    },
    portalSessions: {
      create: (input: { customerId: string; returnUrl: string }) =>
        this.request<R>({ method: 'POST', path: '/api/v1/payment/portal-sessions', body: input, idempotencyKey: this.genIdem() }),
    },
    webhookEndpoints: {
      list: () => this.request<L>({ method: 'GET', path: '/api/v1/payment/webhook-endpoints' }),
      create: (input: { url: string; events?: string[] }) =>
        this.request<R>({ method: 'POST', path: '/api/v1/payment/webhook-endpoints', body: input, idempotencyKey: this.genIdem() }),
      delete: (id: string) =>
        this.request<R>({ method: 'DELETE', path: `/api/v1/payment/webhook-endpoints/${id}` }),
    },
    webhookEvents: {
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/payment/webhook-events${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/payment/webhook-events/${id}` }),
    },
  };

  // ═══════════════════════════════════════════════════════════════════
  // STOREFRONT
  // ═══════════════════════════════════════════════════════════════════
  storefront = {
    products: {
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/storefront/products${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/storefront/products/${id}` }),
      create: (input: R) => this.request<R>({ method: 'POST', path: '/api/v1/storefront/products', body: input, idempotencyKey: this.genIdem() }),
      update: (id: string, patch: R) => this.request<R>({ method: 'PATCH', path: `/api/v1/storefront/products/${id}`, body: patch }),
      archive: (id: string) => this.request<R>({ method: 'DELETE', path: `/api/v1/storefront/products/${id}` }),
      addFile: (productId: string, input: R) =>
        this.request<R>({ method: 'POST', path: `/api/v1/storefront/products/${productId}/files`, body: input }),
      removeFile: (productId: string, fileId: string) =>
        this.request<R>({ method: 'DELETE', path: `/api/v1/storefront/products/${productId}/files/${fileId}` }),
    },
    licenses: {
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/storefront/licenses${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/storefront/licenses/${id}` }),
      issue: (input: R) =>
        this.request<R>({ method: 'POST', path: '/api/v1/storefront/licenses', body: input, idempotencyKey: this.genIdem() }),
      /** Revokes a license by its key (DELETE /storefront/licenses/{key}). */
      revoke: (key: string) =>
        this.request<void>({ method: 'DELETE', path: `/api/v1/storefront/licenses/${key}` }),
    },
    deliveries: {
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/storefront/deliveries${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/storefront/deliveries/${id}` }),
    },
    public: {
      get: (slug: string) => this.request<R>({ method: 'GET', path: `/api/v1/storefront/public/${slug}` }),
    },
  };

  // ═══════════════════════════════════════════════════════════════════
  // ACCOUNT (marketing + settings)
  // ═══════════════════════════════════════════════════════════════════
  account = {
    profile: () => this.request<R>({ method: 'GET', path: '/api/v1/account' }),
    updateProfile: (patch: R) => this.request<R>({ method: 'PATCH', path: '/api/v1/account', body: patch }),
    pixels: {
      get: () => this.request<R>({ method: 'GET', path: '/api/v1/account/pixels' }),
      update: (patch: R) => this.request<R>({ method: 'PATCH', path: '/api/v1/account/pixels', body: patch }),
    },
    abandonedCart: {
      getConfig: () => this.request<R>({ method: 'GET', path: '/api/v1/account/abandoned-cart' }),
      updateConfig: (patch: R) => this.request<R>({ method: 'PATCH', path: '/api/v1/account/abandoned-cart', body: patch }),
    },
    feeds: {
      getConfig: () => this.request<R>({ method: 'GET', path: '/api/v1/account/feeds' }),
      updateConfig: (patch: R) => this.request<R>({ method: 'PATCH', path: '/api/v1/account/feeds', body: patch }),
    },
    blog: {
      /** `{ posts: [...] }` */
      list: (params: R = {}) => this.request<{ posts: L }>({ method: 'GET', path: `/api/v1/account/blog/posts${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/account/blog/posts/${id}` }),
      create: (input: R) => this.request<R>({ method: 'POST', path: '/api/v1/account/blog/posts', body: input }),
      update: (id: string, patch: R) => this.request<R>({ method: 'PATCH', path: `/api/v1/account/blog/posts/${id}`, body: patch }),
      publish: (id: string) => this.request<R>({ method: 'POST', path: `/api/v1/account/blog/posts/${id}/publish`, body: {} }),
      delete: (id: string) => this.request<R>({ method: 'DELETE', path: `/api/v1/account/blog/posts/${id}` }),
    },
    referrals: {
      getProgram: () => this.request<R>({ method: 'GET', path: '/api/v1/account/referrals' }),
      updateProgram: (program: R) => this.request<R>({ method: 'PUT', path: '/api/v1/account/referrals', body: program }),
    },
    /** Creating and revoking keys needs a signed-in session; an API key gets 403. */
    apiKeys: {
      list: () => this.request<L>({ method: 'GET', path: '/api/v1/account/api-keys' }),
      create: (input: { name: string; environment: 'production' | 'sandbox' }) =>
        this.request<R>({ method: 'POST', path: '/api/v1/account/api-keys', body: input, idempotencyKey: this.genIdem() }),
      revoke: (id: string) =>
        this.request<void>({ method: 'DELETE', path: `/api/v1/account/api-keys/${id}` }),
    },
    auditLog: {
      list: (params: R = {}) =>
        this.request<L>({ method: 'GET', path: `/api/v1/account/audit-log${qs(params)}` }),
    },
    domains: {
      list: () => this.request<L>({ method: 'GET', path: '/api/v1/account/domains' }),
      add: (input: { domain: string }) =>
        this.request<R>({ method: 'POST', path: '/api/v1/account/domains', body: input }),
      verify: (id: string) =>
        this.request<R>({ method: 'POST', path: `/api/v1/account/domains/${id}/verify`, body: {} }),
      remove: (id: string) =>
        this.request<R>({ method: 'DELETE', path: `/api/v1/account/domains/${id}` }),
    },
  };

  // ═══════════════════════════════════════════════════════════════════
  // OTHER TOP-LEVEL
  // ═══════════════════════════════════════════════════════════════════
  analytics = {
    overview: () => this.request<R>({ method: 'GET', path: '/api/v1/analytics/overview' }),
  };

  billing = {
    plans: () => this.request<L>({ method: 'GET', path: '/api/v1/billing/plans' }),
    subscription: () => this.request<R>({ method: 'GET', path: '/api/v1/billing/subscription' }),
    usage: () => this.request<R>({ method: 'GET', path: '/api/v1/billing/usage' }),
    invoices: (params: R = {}) =>
      this.request<L>({ method: 'GET', path: `/api/v1/billing/invoices${qs(params)}` }),
    /** Upgrade: starts a Plugipay subscription for the tier and returns where to pay. */
    checkout: (input: { plan: 'pro' | 'business' | 'scale'; interval?: 'month' | 'year'; currency?: string }) =>
      this.request<R>({ method: 'POST', path: '/api/v1/billing/plugipay-invoice', body: input, idempotencyKey: this.genIdem() }),
    cancel: () => this.request<R>({ method: 'POST', path: '/api/v1/billing/cancel', body: {} }),
  };

  modules = {
    /** `{ modules, allowed, plan }`: each module's on/off state and which ones the plan allows. */
    list: () => this.request<R>({ method: 'GET', path: '/api/v1/modules' }),
    enable: (name: 'payment' | 'fulfillment' | 'marketing') =>
      this.request<R>({ method: 'POST', path: '/api/v1/modules', body: { module: name, enabled: true } }),
    disable: (name: 'payment' | 'fulfillment' | 'marketing') =>
      this.request<R>({ method: 'POST', path: '/api/v1/modules', body: { module: name, enabled: false } }),
  };

  manualOrders = {
    list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/manual-orders${qs(params)}` }),
    get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/manual-orders/${id}` }),
  };

  onboarding = {
    status: () => this.request<R>({ method: 'GET', path: '/api/v1/onboarding' }),
    /** Marks onboarding done; `{ enablePayment: true }` also turns on the Payment module. */
    complete: (input: { enablePayment?: boolean } = {}) =>
      this.request<R>({ method: 'POST', path: '/api/v1/onboarding/complete', body: input }),
  };

  shipping = {
    couriers: () => this.request<L>({ method: 'GET', path: '/api/v1/shipping/couriers' }),
    origin: () => this.request<R>({ method: 'GET', path: '/api/v1/shipping/origin' }),
    setOrigin: (input: R) => this.request<R>({ method: 'PATCH', path: '/api/v1/shipping/origin', body: input }),
    rates: (input: R) => this.request<R>({ method: 'POST', path: '/api/v1/shipping/rates', body: input }),
    listShipments: (params: R = {}) =>
      this.request<L>({ method: 'GET', path: `/api/v1/shipping/shipments${qs(params)}` }),
    createShipment: (input: R) =>
      this.request<R>({ method: 'POST', path: '/api/v1/shipping/shipments', body: input, idempotencyKey: this.genIdem() }),
  };

  inventory = {
    /** Stock levels of one variant: `{ variantId }` is required. */
    levels: (params: { variantId: string } & R) =>
      this.request<L>({ method: 'GET', path: `/api/v1/inventory/stock${qs(params)}` }),
    movements: (params: R = {}) =>
      this.request<L>({ method: 'GET', path: `/api/v1/inventory/movements${qs(params)}` }),
    adjust: (input: R) =>
      this.request<R>({ method: 'POST', path: '/api/v1/inventory/adjust', body: input, idempotencyKey: this.genIdem() }),
    warehouses: () => this.request<L>({ method: 'GET', path: '/api/v1/inventory/warehouses' }),
    addWarehouse: (input: R) =>
      this.request<R>({ method: 'POST', path: '/api/v1/inventory/warehouses', body: input }),
  };

  ledger = {
    list: (params: R = {}) =>
      this.request<L>({ method: 'GET', path: `/api/v1/ledger/entries${qs(params)}` }),
    balances: () => this.request<R>({ method: 'GET', path: '/api/v1/ledger/balance' }),
    adjust: (input: R) =>
      this.request<R>({ method: 'POST', path: '/api/v1/ledger/adjustments', body: input, idempotencyKey: this.genIdem() }),
  };

  reports = {
    pnl: (params: { from: string; to: string }) =>
      this.request<R>({ method: 'GET', path: `/api/v1/reports/pnl${qs(params)}` }),
    cashFlow: (params: { from: string; to: string }) =>
      this.request<R>({ method: 'GET', path: `/api/v1/reports/cash-flow${qs(params)}` }),
    /** The whole ledger as CSV text (GET /ledger/entries.csv). */
    exportLedger: () => this.request<string>({ method: 'GET', path: '/api/v1/ledger/entries.csv' }),
  };

  payouts = {
    list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/payouts${qs(params)}` }),
    get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/payouts/${id}` }),
    request: (input: R) => this.request<R>({ method: 'POST', path: '/api/v1/payouts', body: input, idempotencyKey: this.genIdem() }),
    bankAccount: () => this.request<R>({ method: 'GET', path: '/api/v1/payouts/bank-account' }),
    updateBankAccount: (input: R) =>
      this.request<R>({ method: 'PATCH', path: '/api/v1/payouts/bank-account', body: input }),
  };

  discountCodes = {
    list: (params: R = {}) =>
      this.request<L>({ method: 'GET', path: `/api/v1/discount-codes${qs(params)}` }),
    get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/discount-codes/${id}` }),
    create: (input: R) =>
      this.request<R>({ method: 'POST', path: '/api/v1/discount-codes', body: input, idempotencyKey: this.genIdem() }),
    update: (id: string, patch: R) =>
      this.request<R>({ method: 'PATCH', path: `/api/v1/discount-codes/${id}`, body: patch }),
  };
}
