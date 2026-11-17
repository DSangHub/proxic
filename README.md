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
2. Install pnpm, Node.js 22, and Azure Functions Core Tools.
3. Run `pnpm install`.
4. Run `pnpm dev` for the web app.
5. In another terminal run `pnpm --filter @proxic/functions dev` for Azure Functions.

The web app defaults to `http://localhost:7071/api` for its backend.
Enable Google as a Firebase Authentication provider and configure authorized domains before signing in. See [deployment notes](docs/deployment.md) for credentials and CORS.

The web app sends a Firebase ID token as `Authorization: Bearer <token>` when assigning a proxy. `GET /api/auth/me` returns the verified user's profile; `POST /api/proxy` requires the same token.

Run backend authentication tests with `pnpm --filter @proxic/functions test`.

## Vercel
Import the Git repository and set the Vercel project's Root Directory to `apps/web`. Add `NEXT_PUBLIC_API_URL` pointing to the deployed Azure Function App.

## Azure Functions
Deploy `services/functions` as the Function App package. Configure required settings in Azure rather than committing secrets.

## Safety model
AI produces a `ProposedAction`. A deterministic policy classifies the action, and sensitive actions remain `awaiting_approval`. This starter intentionally contains no bank-transfer or payment execution code.
