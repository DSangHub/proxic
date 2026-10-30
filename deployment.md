# Deployment notes

## Vercel
Use `apps/web` as the project Root Directory and configure `NEXT_PUBLIC_API_URL` with the public Azure Functions `/api` base URL.

## Azure
Create an Azure Function App compatible with the Node.js v4 programming model and deploy `services/functions`. Store runtime secrets in Azure configuration/Key Vault rather than source control.

## GitHub
CI builds and type-checks the monorepo. Add a separate Azure deployment workflow only after creating the Function App and configuring GitHub/Azure deployment credentials.
