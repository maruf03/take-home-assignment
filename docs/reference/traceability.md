# Traceability matrix

Every brief requirement (`R#`) and core invariant (`I#`) maps to tests. Test names carry the ID,
for example `it('[R7] …')`. `pnpm trace:check` runs as the final CI fan-in job and fails when an ID has no
passing test, except IDs marked **Extended**, which gate only once their Extended task is built. Matrix tests can never be quarantined. The source is §11.2 of the
[design spec](../superpowers/specs/2026-11-27-document-review-design.md); keep the two in sync.

| ID | Requirement or invariant | Tests | Tier |
|---|---|---|---|
| R1 | Upload is instant and never waits on the LLM | `api.upload.returns-before-llm` (fake LLM latched; 201 < 300 ms, status queued); e2e upload journey | int, e2e |
| R2 | A restart mid-extraction recovers | `chaos.sigkill-mid-llm` (before and after C2); `worker.boot-releases-own-leases`; `sweep.expired-lease-requeues` | chaos, int |
| R3 | FLUSHALL loses nothing | `chaos.flushall-mid-queue`; `sweep.leftover-finished-job-removed`; compose-smoke FLUSHALL + restart | chaos, int, CI |
| R4 | No duplicate values | `db.finalize-twice-noop`, `worker.redelivery-after-commit`, `conc.claims-one-winner`, `db.unique-version-field`, `worker.zombie-finalize-rejected` | int, conc |
| R5 | A failure is a state and is retryable | `worker.llm-401-permanent`, `worker.parse-malformed`, `api.retry-202/409`, `worker.LLM_NOT_CONFIGURED`, `worker.max-attempts`; compose-smoke keyless | int, CI |
| R6 | Verbatim evidence, otherwise a gap | core `evidence.*` (all gap codes, quote span, quote_folded, split lines, hidden); DB CHECK rejects a gap that carries a value | unit, int |
| R7 | Carry-over is exactly the changed set | core `carryover.invoice-v2.exact-set` × {full, bare-date, label-less, layout} cassettes; property `shift-invariance`; `pipeline.v1-review-v2`; e2e v2 journey | unit, int, e2e |
| R8 | A changed value shows its previous value and review | `api.detail.previous`; web `ValueRow.changed`; e2e | int, web, e2e |
| R9 | A new version can arrive during extraction | `conc.v2-during-v1`, `conc.v1-finishes-after-v2` | conc |
| R10 | History stays queryable | `api.version-history-after-v2`, `api.v1-values-readonly` | int |
| R11 | Seed runs on `compose up` | `seed.idempotent`, `seed.no-resurrect-deleted` *(Extended E1a)*; compose-smoke | int, CI |
| R12 | Progress counts | `api.progress.disjoint-sum`, `conc.pending_count-invariant` | int, conc |
| I1 | Fencing | `db.heartbeat-0-rows-aborts`, `worker.fenced-write-after-lease-loss`, `conc.delete-revokes-fence` *(Extended E1a)* | int, conc |
| I2 | Idempotency-Key **(Extended E1b)** | `api.idem.replay`, `api.idem.reused-422`, `conc.idem.concurrent-dup`, `api.idem.replay-after-delete` | int, conc |
| I3 | No double billing | `worker.crash-after-llm-reuses-call`, `worker.manual-retry-fresh`, `worker.call-cap-6` | int |
| I4 | Pagination has no duplicates or skips (forward in Core; prev symmetry Extended E1d) | `pagination.model` (fc.commands), `pagination.cursor-mismatch`, `pagination.explain-uses-index` | int |
| I5 | Soft delete never leaks **(Extended E1a)** | `api.leak.route-table` | int |
| I6 | A′ edge cases | core table: weak line, PARSER_CHANGED, POSSIBLE_AMENDMENT, EVIDENCE_CHANGED, conflicting lines, hidden baseline, gap→gap, chains, carried correction, revert baseline *(Extended E1c)* | unit |
| I7 | Templates | `seed.template-hash-idempotent`, `seed.edited-template-v2-pin` | int |
| I8 | Security controls | `sec.*` (upload, headers, filename, no stack, throttle, injection, key isolation, dev-default denylist, cassette provider refused outside test) | sec |
| I9 | Parser hardening | `pdf.crafted.*`, `pdf.child-killed-worker-survives` | pdf |
| I10 | DB privileges | `db.grants.snapshot`, `db.grants.app-cannot-update-reviews`, `db.grants.app-cannot-delete-documents` | int |
| I11 | Undo/revert **(Extended E1c)** | `api.review.revert-to-pending`, `api.review.revert-requires-expected`, `core.carryover.revert-baseline-not-carried`, `conc.pending_count-revert` | int, unit, conc |
| I12 | UI 5-second rule and a11y | e2e: Needs review count above the fold, Changed group first, focus on the first row; axe zero serious on every state (light theme (dark: *Extended E1c*)); shortcuts inert inside inputs *(Extended E1c)* | e2e |

`scripts/trace-check.ts` runs as a **final fan-in CI job** (`needs: [check, integration, compose-smoke, e2e]`). It downloads every job's JUnit artifact, then diffs the test names against this table. A missing or failing ID
fails CI, and **matrix tests can never be quarantined**.

