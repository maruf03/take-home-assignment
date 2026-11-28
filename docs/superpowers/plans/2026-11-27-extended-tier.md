# Extended Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Start only when every Core task is green.** Work in order. Any item not built is listed in README "Deliberate cuts" with its reason.

**Goal:** Add the features moved out of Core in spec §15.3 (soft delete, idempotency keys, UI extras, bidirectional paging, secondary docs), then hardening and quality tooling. A live deployment comes last and is optional: local `docker compose up` is the supported evaluation path.

**Architecture:** Additive only. Core behaviour and contracts don't change.

**Tech Stack:** AWS (ECS Fargate, RDS PG 18, ElastiCache, S3, Secrets Manager) or a simpler host, Terraform, Trivy, Syft, Renovate, oasdiff, Stryker, fast-check scheduler, size-limit.

**Spec:** `docs/superpowers/specs/2026-11-27-document-review-design.md` §15.2.

## Global Constraints
- Every Core global constraint still applies.
- **No secrets in pull-request workflows.** Deploy and eval run only in protected environments.

## Review Focus
1. If a live deployment is ever done (E11), it must keep the LLM key on the worker only, and must keep Redis disposable.
2. A hidden-text detector that misreads visible text as hidden would turn valid evidence into false gaps. It needs a golden test on every fixture before it's enabled.

---

### Task E1a: Soft delete, restore, Trash (moved from Core in §15.3)
- [ ] Add `DELETE /documents/:id` (204, repeat → 204) and `POST /restore` (200, also on a no-op). The delete tx revokes fences; restore resets attempts and errors and re-queues.
- [ ] Every nested route under a deleted document → 410 `DOCUMENT_DELETED`. Add `?deleted=include|only` with the `(deleted_at, id)` keyset; encode `deleted_at` as text.
- [ ] Tests: `[I5]` route-table leak; delete during extraction with a zombie write rejected; restore after a delete during attempt 5; the seed never resurrects. Web: Trash tab and the 410 page.

### Task E1b: Idempotency-Key table (moved from Core)
- [ ] Add the `idempotency_keys` table (§4.11, nullable response columns plus `response_meta`) and its migration. Grants: full DML.
- [ ] Insert the key first (`ON CONFLICT DO NOTHING`), keeping lock order. Replays return the stored status plus the current representation. Purge expired keys in the TTL sweep.
- [ ] Tests: `[I2]` replay, reuse with a different body → 422, concurrent duplicates → one resource, replay after delete → stored 201.

### Task E1c: UI extras (moved from Core; partially promoted to Core Task 15)
- [ ] Original tab rendered with pdf.js (E7, ADR-0012).
- [x] Revert undo toast (`decision:'revert'`, `[I11]`, `NOTHING_TO_REVERT`) — promoted to Core Task 15.
- [x] Frozen row order with Re-sort and keyboard shortcuts with a toggle — promoted to Core Task 15.
- [ ] Inline Keep theirs / Apply mine conflict card and dark mode (axe on both themes).

### Task E1d: Bidirectional paging and secondary docs (moved from Core; paging promoted to Core Task 15)
- [x] Add `prevCursor` and `Link: rel="prev"`, with a model test for next/prev symmetry — promoted to Core Task 15.
- [ ] Write the 🧭 docs in `docs/INDEX.md`: explanation (extraction-core, concurrency, security), reference (api, schema, error-codes, configuration), how-to (testing, record-cassettes, update-goldens, add-document-type).

### Task E2: Supply chain (Trivy, SBOM, Renovate)
- [ ] Add a Trivy scan to the `images` job that fails on CRITICAL or HIGH findings (unfixed ones ignored), and generate an SPDX SBOM.
- [ ] Add `renovate.json`, with pdfjs and unpdf updates requiring manual approval.

### Task E3: API contract diff *(promoted to Core Task 15)*
- [x] Commit `docs/reference/openapi.json`, and run oasdiff in `check` so breaking changes need a label.

### Task E4: Hidden-text detection by render mode
- [ ] Spike first: generate a PDF with crafted render-mode-3 text, then correlate `getOperatorList` `setTextRenderingMode` with `getTextContent` items, handling save/restore and XObjects.
- [ ] Enable it only if all four fixtures produce zero hidden ranges. Turn the detected ranges into `EVIDENCE_HIDDEN`.

### Task E5: Randomized interleavings
- [ ] Build an `fc.scheduler` over the lock-barrier release order, run with 50 seeds on PRs and 2,000 nightly, with the seed logged.

### Task E6: Mutation testing
- [ ] Run Stryker on `packages/core` nightly. Report against thresholds of 85 (evidence and carryover) and 70 (everything else), and alert on any drop of more than 3 points.

### Task E7: Terraform
- [ ] Write the `infra/terraform/aws` modules from §10.8, and run `fmt`, `validate` and `tflint` in CI. Never apply them from CI.

### Task E8: Bundle budget *(promoted to Core Task 15)*
- [x] Use `size-limit` to cap the initial JavaScript at 200 KB gzip, or the measured size plus 10%. The pdf.js chunk is excluded because it is lazy-loaded.

### Task E9: e2e coverage
- [ ] Collect v8 coverage from the e2e containers and merge it. Do this only if earlier tasks are done.

### Task E10: Quarantine automation
- [ ] Generate `test/quarantine.json` from tests that pass on retry, with an owner and a 7-day expiry. Expired entries fail CI.

### Task E11: Live deployment (lowest priority)
- [ ] Only after everything above. Running locally via `docker compose up` is the supported way to evaluate (owner decision).
- [ ] Pick a target: ECS Fargate from §10.8, or a simpler managed host if time is short. Write the choice down in an ADR.
- [ ] Deploy the Core images, with managed Postgres 18, Redis and S3. Keep the worker's minimum instance count at 1 or more.
- [ ] Write `docs/how-to/deploy.md`, and put the link in `docs/submission.md`.
