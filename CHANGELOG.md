# Changelog

## 0.2.0
- **Auth is an API key now.** Pass `apiKey`: an `sk_live_…` / `sk_test_…` key from Settings → API keys (default: env `STORLAUNCH_API_KEY`), sent as `Authorization: Bearer <key>`. The `keyId`/`secret` request signing and `forMerchant()`/`onBehalfOf` (`X-Storlaunch-On-Behalf-Of`) are removed: the API never accepted them, so every call answered 401. A key belongs to one workspace.
- Writes send their idempotency key as `X-Idempotency-Key` (what Storlaunch's replay guard reads; subscription and portal-session creates require it) and `Idempotency-Key` (what it forwards to Plugipay).
- A 204 returns undefined; a CSV export returns its text.
- Methods now call the route the API really has: `payment.plans.archive` → `DELETE /payment/plans/{id}`; `payment.subscriptions.cancel(id, { immediate })` → `DELETE /payment/subscriptions/{id}`; `storefront.licenses.revoke(key)` → `DELETE /storefront/licenses/{key}`; `account.apiKeys.revoke` → `DELETE /account/api-keys/{id}` and `create` takes `name` + `environment`; `account.referrals.updateProgram` → `PUT`; `billing.checkout({plan, interval, currency})` → `POST /billing/plugipay-invoice`; `modules.enable/disable` → `POST /modules {module, enabled}`; `inventory.levels({variantId})` → `GET /inventory/stock`; `ledger.list/balances/adjust` → `/ledger/entries`, `/ledger/balance`, `/ledger/adjustments`; `reports.exportLedger()` → `GET /ledger/entries.csv`; `onboarding.completeStep` → `onboarding.complete({enablePayment})`.
- Removed, because the API has no such route: `payment.invoices.finalize/pay/void`, `payment.plugipaySettings`, `storefront.products.listFiles` (files come with `products.get`), `storefront.deliveries.create`, `analytics.storefront/funnel`, `billing.currentPlan` (use `billing.subscription`), `modules.status` (use `modules.list`), `manualOrders.create`, `discountCodes.validate`, `inboundWebhooks`. Also removed: `buyer`, whose shopper routes take the shopper's storefront session, never an API key.
- `account.blog.list` is typed as what it returns, `{ posts }`.
- A test checks every hand-written method's route against the API spec (`backend/openapi.json`).

## 0.1.2
- `client.api`: every feature route of the Storlaunch API, one method each (`client.api.<area><Action>(...)`), generated from the API spec and signed like every other call. `GeneratedApi` is exported.

## 0.1.1
- Package metadata now points at the public mirror repo (github.com/hachimi-cat/storlaunch-node).

## 0.1.0
- Prior release.
