import crypto from 'node:crypto';
import { ApiEnvelope, StorlaunchError } from './types.js';

export interface StorlaunchClientOptions {
  /** HMAC access key id, e.g. 'AKIASTOR<random>'. */
  keyId: string;
  /** HMAC secret. */
  secret: string;
  /** Base URL. Default https://storlaunch.com. */
  baseUrl?: string;
  /** Optional merchant accountId — forwarded as `X-Storlaunch-On-Behalf-Of`.
   *  Only allowed when `keyId` holds the `storlaunch:platform:admin` scope. */
  onBehalfOf?: string;
  /** Per-request fetch timeout. Default 30s. */
  timeoutMs?: number;
}

interface SignInput {
  method: string;
  path: string;
  body: string | null;
  idempotencyKey?: string;
}

export interface FetchArgs {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  onBehalfOf?: string;
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
  private readonly keyId: string;
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly defaultOnBehalfOf: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: StorlaunchClientOptions) {
    if (!opts.keyId || !opts.secret) throw new Error('StorlaunchClient: keyId and secret are required');
    this.keyId = opts.keyId;
    this.secret = opts.secret;
    this.baseUrl = (opts.baseUrl ?? 'https://storlaunch.com').replace(/\/+$/, '');
    this.defaultOnBehalfOf = opts.onBehalfOf;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  forMerchant(accountId: string): StorlaunchClient {
    return new StorlaunchClient({
      keyId: this.keyId,
      secret: this.secret,
      baseUrl: this.baseUrl,
      onBehalfOf: accountId,
      timeoutMs: this.timeoutMs,
    });
  }

  private sign({ method, path, body, idempotencyKey }: SignInput): { signature: string; timestamp: string } {
    const ts = String(Math.floor(Date.now() / 1000));
    const bodyHash = crypto.createHash('sha256').update(body ?? '').digest('hex');
    const idem = idempotencyKey ? `\n${idempotencyKey}` : '';
    const stringToSign = `${method.toUpperCase()}\n${path}\n${ts}\n${bodyHash}${idem}`;
    const signature = crypto.createHmac('sha256', this.secret).update(stringToSign).digest('hex');
    return { signature, timestamp: ts };
  }

  async request<T>(args: FetchArgs): Promise<T> {
    const bodyJson = args.body !== undefined ? JSON.stringify(args.body) : null;
    const { signature, timestamp } = this.sign({
      method: args.method,
      path: args.path,
      body: bodyJson,
      idempotencyKey: args.idempotencyKey,
    });
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Storlaunch-HMAC-SHA256 keyId=${this.keyId}, scope=*, signature=${signature}`,
      'X-Storlaunch-Timestamp': timestamp,
      ...(bodyJson ? { 'Content-Type': 'application/json' } : {}),
      ...(args.idempotencyKey ? { 'Idempotency-Key': args.idempotencyKey } : {}),
    };
    const effective = args.onBehalfOf ?? this.defaultOnBehalfOf;
    if (effective) headers['X-Storlaunch-On-Behalf-Of'] = effective;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${args.path}`, {
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
    let env: ApiEnvelope<T>;
    try { env = JSON.parse(text) as ApiEnvelope<T>; }
    catch { throw new StorlaunchError(res.status, 'invalid_response', `Non-JSON response: ${text.slice(0, 200)}`); }
    if (!res.ok || env.error) {
      const err = env.error ?? { code: 'unknown', message: `HTTP ${res.status}` };
      throw new StorlaunchError(res.status, err.code, err.message, env.meta?.requestId);
    }
    return env.data as T;
  }

  private genIdem(): string { return `idem_${crypto.randomUUID()}`; }

  /** Generic escape hatch for routes not yet typed. */
  async passthrough<T = unknown>(method: FetchArgs['method'], path: string, body?: unknown): Promise<T> {
    return this.request<T>({ method, path, body });
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
      archive: (id: string) => this.request<R>({ method: 'POST', path: `/api/v1/payment/plans/${id}/archive`, body: {} }),
    },
    subscriptions: {
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/payment/subscriptions${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/payment/subscriptions/${id}` }),
      create: (input: R) => this.request<R>({ method: 'POST', path: '/api/v1/payment/subscriptions', body: input, idempotencyKey: this.genIdem() }),
      cancel: (id: string, input: R = {}) => this.request<R>({ method: 'POST', path: `/api/v1/payment/subscriptions/${id}/cancel`, body: input }),
    },
    invoices: {
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/payment/invoices${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/payment/invoices/${id}` }),
      finalize: (id: string) => this.request<R>({ method: 'POST', path: `/api/v1/payment/invoices/${id}/finalize`, body: {} }),
      pay: (id: string) => this.request<R>({ method: 'POST', path: `/api/v1/payment/invoices/${id}/pay`, body: {}, idempotencyKey: this.genIdem() }),
      void: (id: string) => this.request<R>({ method: 'POST', path: `/api/v1/payment/invoices/${id}/void`, body: {} }),
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
    plugipaySettings: {
      get: () => this.request<R>({ method: 'GET', path: '/api/v1/payment/plugipay-settings' }),
      update: (patch: R) => this.request<R>({ method: 'PATCH', path: '/api/v1/payment/plugipay-settings', body: patch }),
    },
    portalSessions: {
      create: (input: { customerId: string; returnUrl: string }) =>
        this.request<R>({ method: 'POST', path: '/api/v1/payment/portal-sessions', body: input }),
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
      listFiles: (productId: string) =>
        this.request<L>({ method: 'GET', path: `/api/v1/storefront/products/${productId}/files` }),
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
      revoke: (id: string) =>
        this.request<R>({ method: 'POST', path: `/api/v1/storefront/licenses/${id}/revoke`, body: {} }),
    },
    deliveries: {
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/storefront/deliveries${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/storefront/deliveries/${id}` }),
      create: (input: R) =>
        this.request<R>({ method: 'POST', path: '/api/v1/storefront/deliveries', body: input, idempotencyKey: this.genIdem() }),
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
      list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/account/blog/posts${qs(params)}` }),
      get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/account/blog/posts/${id}` }),
      create: (input: R) => this.request<R>({ method: 'POST', path: '/api/v1/account/blog/posts', body: input }),
      update: (id: string, patch: R) => this.request<R>({ method: 'PATCH', path: `/api/v1/account/blog/posts/${id}`, body: patch }),
      publish: (id: string) => this.request<R>({ method: 'POST', path: `/api/v1/account/blog/posts/${id}/publish`, body: {} }),
      delete: (id: string) => this.request<R>({ method: 'DELETE', path: `/api/v1/account/blog/posts/${id}` }),
    },
    referrals: {
      getProgram: () => this.request<R>({ method: 'GET', path: '/api/v1/account/referrals' }),
      updateProgram: (patch: R) => this.request<R>({ method: 'PATCH', path: '/api/v1/account/referrals', body: patch }),
    },
    apiKeys: {
      list: () => this.request<L>({ method: 'GET', path: '/api/v1/account/api-keys' }),
      create: (input: R = {}) =>
        this.request<R>({ method: 'POST', path: '/api/v1/account/api-keys', body: input, idempotencyKey: this.genIdem() }),
      revoke: (id: string) =>
        this.request<R>({ method: 'POST', path: `/api/v1/account/api-keys/${id}/revoke`, body: {} }),
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
    storefront: (params: R = {}) =>
      this.request<R>({ method: 'GET', path: `/api/v1/analytics/storefront${qs(params)}` }),
    funnel: (params: R = {}) =>
      this.request<R>({ method: 'GET', path: `/api/v1/analytics/funnel${qs(params)}` }),
  };

  billing = {
    plans: () => this.request<L>({ method: 'GET', path: '/api/v1/billing/plans' }),
    currentPlan: () => this.request<R>({ method: 'GET', path: '/api/v1/billing/plan' }),
    subscription: () => this.request<R>({ method: 'GET', path: '/api/v1/billing/subscription' }),
    usage: () => this.request<R>({ method: 'GET', path: '/api/v1/billing/usage' }),
    invoices: (params: R = {}) =>
      this.request<L>({ method: 'GET', path: `/api/v1/billing/invoices${qs(params)}` }),
    checkout: (input: { planId: string; successUrl?: string; cancelUrl?: string }) =>
      this.request<R>({ method: 'POST', path: '/api/v1/billing/checkout', body: input }),
    cancel: () => this.request<R>({ method: 'POST', path: '/api/v1/billing/cancel', body: {} }),
  };

  modules = {
    list: () => this.request<L>({ method: 'GET', path: '/api/v1/modules' }),
    enable: (name: string) => this.request<R>({ method: 'POST', path: `/api/v1/modules/${name}/enable`, body: {} }),
    disable: (name: string) => this.request<R>({ method: 'POST', path: `/api/v1/modules/${name}/disable`, body: {} }),
    status: (name: string) => this.request<R>({ method: 'GET', path: `/api/v1/modules/${name}` }),
  };

  manualOrders = {
    list: (params: R = {}) => this.request<L>({ method: 'GET', path: `/api/v1/manual-orders${qs(params)}` }),
    create: (input: R) => this.request<R>({ method: 'POST', path: '/api/v1/manual-orders', body: input, idempotencyKey: this.genIdem() }),
    get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/manual-orders/${id}` }),
  };

  onboarding = {
    status: () => this.request<R>({ method: 'GET', path: '/api/v1/onboarding' }),
    completeStep: (step: string, input: R = {}) =>
      this.request<R>({ method: 'POST', path: `/api/v1/onboarding/${step}`, body: input }),
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
    levels: (params: R = {}) =>
      this.request<L>({ method: 'GET', path: `/api/v1/inventory/levels${qs(params)}` }),
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
      this.request<L>({ method: 'GET', path: `/api/v1/ledger${qs(params)}` }),
    balances: () => this.request<L>({ method: 'GET', path: '/api/v1/ledger/balances' }),
    adjust: (input: R) =>
      this.request<R>({ method: 'POST', path: '/api/v1/ledger/adjust', body: input, idempotencyKey: this.genIdem() }),
  };

  reports = {
    pnl: (params: { from: string; to: string }) =>
      this.request<R>({ method: 'GET', path: `/api/v1/reports/pnl${qs(params)}` }),
    cashFlow: (params: { from: string; to: string }) =>
      this.request<R>({ method: 'GET', path: `/api/v1/reports/cash-flow${qs(params)}` }),
    exportLedger: (params: { from: string; to: string; format?: 'csv' | 'json' }) =>
      this.request<R>({ method: 'GET', path: `/api/v1/reports/export-ledger${qs(params)}` }),
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
    validate: (input: { code: string }) =>
      this.request<R>({ method: 'POST', path: '/api/v1/discount-codes/validate', body: input }),
  };

  inboundWebhooks = {
    list: (params: R = {}) =>
      this.request<L>({ method: 'GET', path: `/api/v1/webhooks${qs(params)}` }),
    get: (id: string) => this.request<R>({ method: 'GET', path: `/api/v1/webhooks/${id}` }),
  };

  // Buyer-facing (no platform auth typically — kept for SDK completeness)
  buyer = {
    listOrders: (params: R = {}) =>
      this.request<L>({ method: 'GET', path: `/api/v1/checkout/orders${qs(params)}` }),
    getOrder: (id: string) =>
      this.request<R>({ method: 'GET', path: `/api/v1/checkout/orders/${id}` }),
    listAddresses: () => this.request<L>({ method: 'GET', path: '/api/v1/checkout/addresses' }),
    addAddress: (input: R) =>
      this.request<R>({ method: 'POST', path: '/api/v1/checkout/addresses', body: input }),
    deleteAddress: (id: string) =>
      this.request<R>({ method: 'DELETE', path: `/api/v1/checkout/addresses/${id}` }),
  };
}
