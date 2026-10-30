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
1. Copy `.env.example` to `.env.local` and add development secrets.
2. Install pnpm, Node.js, and Azure Functions Core Tools.
3. Run `pnpm install`.
4. Run `pnpm dev` for the web app.
5. In another terminal run `pnpm --filter @proxic/functions dev` for Azure Functions.

The web app defaults to `http://localhost:7071/api` for its backend.

## Vercel
Import the Git repository and set the Vercel project's Root Directory to `apps/web`. Add `NEXT_PUBLIC_API_URL` pointing to the deployed Azure Function App.

## Azure Functions
Deploy `services/functions` as the Function App package. Configure required settings in Azure rather than committing secrets.

## Safety model
AI produces a `ProposedAction`. A deterministic policy classifies the action, and sensitive actions remain `awaiting_approval`. This starter intentionally contains no bank-transfer or payment execution code.
