# Proxic Task 5 Azure Functions implementation

Drop-in implementation for Payment Policy + Approval Engine using Azure Functions Node.js v4, Firebase Admin token verification, Prisma/PostgreSQL, deterministic policy evaluation, snapshot-bound approvals, serializable transactions, and audit events.

## Merge steps
1. Copy `src/*` into `services/functions/src/`.
2. Merge `prisma/schema.task5.prisma` into the existing Prisma schema, then add relations to your existing `Bill`, `BankConnection`, and `AuditEvent` models as required by your repo.
3. Add package dependencies from `package.json` to the existing Functions package.
4. Run Prisma format, migration, generate, typecheck, tests, and build.

## Assumptions to adapt
Existing Prisma models are named `Bill`, `BankConnection`, and `AuditEvent`, and contain the fields referenced in `policy-service.ts`. If Task 2 or Task 3 used different names, map those queries accordingly.

## Routes
- `GET|POST /api/payment-policies`
- `GET|PATCH|DELETE /api/payment-policies/:id`
- `POST /api/bills/:id/evaluate-policy`
- `GET /api/approvals`
- `GET /api/approvals/:id`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/reject`
- `POST /api/approvals/:id/cancel`

No payment provider is called. `APPROVED` means authorized and waiting for a future executor, not paid.
