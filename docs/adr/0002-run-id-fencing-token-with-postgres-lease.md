# Fence every worker write with the run id; leases use Postgres time

A worker claims a version by setting `active_run_id` and a 30s `lease_until` (renewed every 10s), and every later write is `WHERE active_run_id = $me`. A worker that lost its lease therefore can't write, even if it wakes up later. Lease predicates use Postgres `now()` only, so clock skew between workers can't exist. Tests use short real durations and a DB-side `expireLease()` instead of an injected clock.

**Considered options:** BullMQ locks alone (lost on flush); advisory locks (held per connection, so they die with the pool); an app-side clock passed into SQL (skew risk).
