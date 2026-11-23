# Proxic

**Proxy Choice: assign an AI proxy to the life-admin work you don't want to do.**

Starter MVP monorepo for `DSangHub/proxic`.

## MVP
- Task Proxy
- Appointment Proxy
- Bill Proxy (proposal/approval only; no real payment execution in starter)
- Approval and risk policy layer
- Next.js web dashboard
- Azure Functions API

## Local development
1. Copy the `NEXT_PUBLIC_*` settings from `.env.example` to `apps/web/.env.local`. Set the Firebase Admin settings in the Azure Functions environment (locally, `services/functions/local.settings.json` under `Values`); never put Admin credentials in the web environment.
2. Install pnpm, Node.js 22, PostgreSQL, and Azure Functions Core Tools. Set the server-only `DATABASE_URL` in the Functions environment.
3. Run `pnpm install`.
4. Run `pnpm --filter @proxic/db build` and `pnpm --filter @proxic/db migrate:deploy` with `DATABASE_URL` set.
5. Run `pnpm dev` for the web app.
6. In another terminal run `pnpm --filter @proxic/functions dev` for Azure Functions.

The web app defaults to `http://localhost:7071/api` for its backend.
Enable Google as a Firebase Authentication provider and configure authorized domains before signing in. See [deployment notes](docs/deployment.md) for credentials and CORS.

The web app sends a Firebase ID token as `Authorization: Bearer <token>` when assigning a proxy. `GET /api/auth/me` returns the verified user's profile; `POST /api/proxy` requires the same token.

Bill routes require the same bearer token: `GET /api/bills`, `GET /api/bills/{id}`, `POST /api/bills/{id}/approve`, and `POST /api/bills/{id}/reject`. `POST /api/bills` accepts a manual structured submission, for example `{"merchant":"Utility","amountMinor":12345,"currency":"USD","dueDate":"2027-01-31","accountLastFour":"1234"}`. Amounts are in the currency's minor unit; `accountLastFour` is optional. The verified token, never the request body, supplies the owner.

Run backend tests with `pnpm --filter @proxic/functions test`. For the PostgreSQL integration test, migrate an isolated test database and set `TEST_DATABASE_URL` when running the tests; without it the integration test is skipped.

## Plaid Sandbox
Create Plaid Sandbox credentials and set `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=sandbox`, and a securely generated `PLAID_TOKEN_ENCRYPTION_KEY` in Azure Functions settings (locally in `services/functions/local.settings.json` under `Values`). Generate the key with `openssl rand -hex 32`. These are server-only settings: never commit their values or put them in Vercel or `NEXT_PUBLIC_*`.

Sign in and use **Connect Bank** in the dashboard's Bank Connections section, then open Plaid Link. The API supports one Plaid Sandbox connection per Firebase user. `POST /api/plaid/link-token` returns `linkToken` and `expiration` for Plaid Link. After Link succeeds, the dashboard sends `{"publicToken":"..."}` to `POST /api/plaid/exchange-token`. Authenticated `GET /api/plaid/connection` returns connection status and masked account metadata. The dashboard loads cached balances via `GET /api/plaid/accounts`; **Refresh Balance** retrieves live Sandbox balances via `GET /api/plaid/balance`. `DELETE /api/plaid/connection` removes the Item at Plaid and deletes its local record. The frontend sends the Firebase ID token as a bearer token to every endpoint. No payment functionality is included.

Each user can have one pending or active connection, with multiple associated account metadata records. The connection stores the Firebase UID, provider, Plaid Item and institution identifiers/name when available, status and timestamps; account records store identifiers, display names, masked last digits, type and subtype. Banking usernames, passwords, full account numbers, and balances are not stored. A pending Link session can be canceled with `DELETE /api/plaid/connection`; call it before starting a replacement or after Link expires. Link tokens and access tokens are encrypted separately at rest and never logged; access tokens are never returned to the browser. Plaid's Transactions product is initialized to enable account/balance access, but transaction history is not fetched. See [deployment notes](docs/deployment.md) for setup and failure recovery.

Bank connection and disconnection are audited alongside their database state changes. Failed authenticated Link-token and exchange attempts are also audited without provider errors or tokens; canceling an unconnected Link session is not a disconnection. A successful exchange followed by a metadata lookup failure records both a connection and a failed exchange attempt.

Run frontend Link flow tests with `pnpm --filter @proxic/web test`.

## Vercel
Import the Git repository and set the Vercel project's Root Directory to `apps/web`. Add `NEXT_PUBLIC_API_URL` pointing to the deployed Azure Function App.

## Azure Functions
Deploy `services/functions` as the Function App package. Configure required settings in Azure rather than committing secrets.

For the forwarding trust boundary, quarantine workflow, and deployment prerequisites, see [bill forwarding](docs/bill-forwarding.md).

For deterministic payment-policy evaluation and approval semantics, see [payment policy](docs/payment-policy.md).

## Safety model
AI produces a `ProposedAction`. A deterministic policy classifies the action, and payment proposals always require approval. Approving a bill records a decision only; it does not authorize or execute a financial transaction. Manual ingestion accepts only a small allowlist of structured fields and never stores raw emails, attachments, full account or card numbers, CVVs, or credentials. Forwarded email and attachments are not accepted yet; a future adapter must authenticate the forwarding channel and resolve the owner through a trusted alias, never through sender-supplied data.
