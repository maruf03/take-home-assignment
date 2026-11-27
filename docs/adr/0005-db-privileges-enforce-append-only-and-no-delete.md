# DB privileges enforce append-only reviews and no hard deletes

The `app` role has `SELECT, INSERT` only on `reviews`, column-level UPDATE on `llm_calls` and `extracted_values`, and no DELETE anywhere except the TTL table `idempotency_keys`. Grants are applied by an idempotent `grants.sql` after migrations, because grants can't be generated, and a privilege snapshot test guards them. Invariants that would otherwise need triggers are enforced by Postgres itself.
