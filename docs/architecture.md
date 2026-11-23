# MVP architecture

User -> Vercel/Next.js -> Azure Functions -> Router -> ProposedAction -> deterministic risk policy -> approval gate -> future tool adapters.

The starter deliberately stops before external financial execution. Add integrations behind a capability-specific tool gateway and record every attempted/approved/executed action in the audit store.
