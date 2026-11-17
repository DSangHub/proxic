# Deployment notes

## Vercel
Use `apps/web` as the project Root Directory. Configure `NEXT_PUBLIC_API_URL` with the public Azure Functions `/api` base URL and set `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, and `NEXT_PUBLIC_FIREBASE_APP_ID` from the Firebase web app configuration at build time. These values are public; do not put Admin credentials in Vercel's web environment.

Enable the Google sign-in provider in Firebase Authentication and add the Vercel hostname (and `localhost` for development) to Firebase Authentication's authorized domains. Configure Azure Functions CORS to allow the exact Vercel and local web origins, including the `Authorization` and `Content-Type` request headers. CORS is not an authentication mechanism.

## Azure
Create an Azure Function App compatible with Node.js 22 and the Node.js v4 programming model. Build from the workspace root and deploy `services/functions` with its compiled `dist` and production dependencies. Set `FIREBASE_PROJECT_ID` to the same Firebase project used by the web app. Configure Application Default Credentials via `GOOGLE_APPLICATION_CREDENTIALS` pointing to a securely provisioned service-account JSON file, or set both `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` from a service account. The private key may use escaped `\n` sequences. Store credentials in Azure configuration/Key Vault, never in source control or `NEXT_PUBLIC_*` variables. The service account needs permission to retrieve Firebase Authentication users for revoked-token checks.

For local Functions development, configure these settings in the ignored `services/functions/local.settings.json` file under `Values` (alongside the usual Azure Functions settings). The function verifies ID tokens, including revocation, on every protected request; an invalid or revoked token returns 401, while configuration or verification-service failures return 500.

## GitHub
CI builds and type-checks the monorepo. Add a separate Azure deployment workflow only after creating the Function App and configuring GitHub/Azure deployment credentials.
