// Shared envelope + error types. Resource shapes use `Record<string, unknown>`
// as a starting point — typed shapes can be added per-resource over time.

export interface ApiEnvelope<T> {
  data: T | null;
  error: { code: string; message: string; docUrl?: string } | null;
  meta?: { requestId: string; timestamp: string; cursor?: string | null; hasMore?: boolean };
}

export class StorlaunchError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;
  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = 'StorlaunchError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export type CurrencyCode = 'IDR' | 'USD';
