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

## Vercel
Import the Git repository and set the Vercel project's Root Directory to `apps/web`. Add `NEXT_PUBLIC_API_URL` pointing to the deployed Azure Function App.

## Azure Functions
Deploy `services/functions` as the Function App package. Configure required settings in Azure rather than committing secrets.

## Safety model
AI produces a `ProposedAction`. A deterministic policy classifies the action, and payment proposals always require approval. Approving a bill records a decision only; it does not authorize or execute a financial transaction. Manual ingestion accepts only a small allowlist of structured fields and never stores raw emails, attachments, full account or card numbers, CVVs, or credentials. Forwarded email and attachments are not accepted yet; a future adapter must authenticate the forwarding channel and resolve the owner through a trusted alias, never through sender-supplied data.
