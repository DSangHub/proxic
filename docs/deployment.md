# Deployment notes

## Vercel
Use `apps/web` as the project Root Directory. Configure `NEXT_PUBLIC_API_URL` with the public Azure Functions `/api` base URL and set `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, and `NEXT_PUBLIC_FIREBASE_APP_ID` from the Firebase web app configuration at build time. These values are public; do not put Admin credentials in Vercel's web environment.

Enable the Google sign-in provider in Firebase Authentication and add the Vercel hostname (and `localhost` for development) to Firebase Authentication's authorized domains. Configure Azure Functions CORS to allow the exact Vercel and local web origins, including the `Authorization` and `Content-Type` request headers. CORS is not an authentication mechanism.

## Azure
Create an Azure Function App compatible with Node.js 22 and the Node.js v4 programming model. Build from the workspace root and deploy `services/functions` with its compiled `dist` and production dependencies. Set `FIREBASE_PROJECT_ID` to the same Firebase project used by the web app. Configure Application Default Credentials via `GOOGLE_APPLICATION_CREDENTIALS` pointing to a securely provisioned service-account JSON file, or set both `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` from a service account. The private key may use escaped `\n` sequences. Store credentials in Azure configuration/Key Vault, never in source control or `NEXT_PUBLIC_*` variables. The service account needs permission to retrieve Firebase Authentication users for revoked-token checks.

For local Functions development, configure these settings in the ignored `services/functions/local.settings.json` file under `Values` (alongside the usual Azure Functions settings). The function verifies ID tokens, including revocation, on every protected request; an invalid or revoked token returns 401, while configuration or verification-service failures return 500.

Set server-only `DATABASE_URL` to PostgreSQL, generate the Prisma client with `pnpm --filter @proxic/db build`, and apply migrations with `pnpm --filter @proxic/db migrate:deploy` before starting Functions. The checked-in first migration is a baseline of the original User/Task/Approval/AuditEvent schema. For an existing database already matching that schema, back it up and baseline it with `pnpm --filter @proxic/db exec prisma migrate resolve --applied 20260101000000_legacy_baseline` before running `migrate:deploy`; do not baseline a new or mismatched database.

Build a Linux deployment artifact from the workspace root with `pnpm build` followed by `pnpm --filter @proxic/functions deploy --legacy --prod /absolute/path/to/function-package`. Generate the Prisma client inside that artifact with `pnpm --filter @proxic/db exec prisma generate --schema /absolute/path/to/function-package/node_modules/@proxic/db/prisma/schema.prisma`. Deploy the resulting directory, including its generated Prisma client and matching platform engine. Generate on a platform compatible with the Azure host.

The duplicate fingerprint compares normalized merchant, amount, currency, due date, and last four within an owner. Matching submissions return 409 and require manual review; similar legitimate bills can match. Creation, detail review, approval, and rejection are audited transactionally. Future payment-state transitions must likewise write `bill.payment_state_changed` in the same transaction, but no such transition or payment execution is implemented.

## GitHub
CI builds and type-checks the monorepo. Add a separate Azure deployment workflow only after creating the Function App and configuring GitHub/Azure deployment credentials.
