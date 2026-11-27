# Glossary

The domain language of this repo. Use these exact terms in code, tests, docs and UI. Defined
behaviour lives in the [design spec](docs/superpowers/specs/2026-11-27-document-review-design.md).

| Term | Meaning |
|---|---|
| **Document** | A stable identity for one client document (`documents` row). It has a type and a title, and it is the only soft-deletable entity (the aggregate root). |
| **Document type** | A kind of document (`invoice`, `lease`, `market_report`). It determines which fields are extracted. |
| **Extraction template** | An immutable, versioned list of fields for a document type (`extraction_templates` + `template_fields`), identified by a content hash. Each version pins one. |
| **Field** | One thing to extract (`field_key`, `field_type` ∈ string, date, money, number, percent). |
| **Version** | One uploaded PDF of a document (`document_versions`), numbered 1…N. It is never mutated or deleted. |
| **Current version** | The **latest uploaded** version (the brief's "current version"). Its status is the document's `status`. |
| **Reviewable version** | The **latest extracted** version (`documents.reviewable_version_id`, API `valuesVersion`). It is the only version whose values can be reviewed. |
| **Parsed text** | A version's text as our line builder produces it, cleaned at parse time and stored once. All offsets index into it. A stored version is never re-parsed. |
| **Run** | One extraction attempt on a version (`extraction_runs`). Its id is the **fencing token**. |
| **Lease** | A time-limited claim on a version (`lease_until`), renewed by heartbeat. When it expires, the sweep can recover the version. |
| **Fencing token** | `document_versions.active_run_id`. Every worker write requires `active_run_id = $me`, so a zombie worker can't write. |
| **Sweep** | The worker's periodic reconciler. It re-enqueues lost work from Postgres and expires leases. Redis is rebuildable from Postgres. |
| **Checkpoint** | A durable, fenced write inside a run: C1 parsed text, C2 each LLM call (stored before validation), C3 finalize. |
| **LLM call** | One request/response to the provider (`llm_calls`), stored verbatim. It is reused on recovery when `request_sha256` matches, so it is never billed twice. |
| **Value** | One extracted field of one version (`extracted_values`). Its kind is either `value` or `gap`. |
| **Gap** | A field with no trustworthy value (`value: null`) and a reason code: `NOT_FOUND`, `MODEL_OMITTED`, `EVIDENCE_NOT_IN_TEXT`, `VALUE_NOT_SUPPORTED`, `UNPARSEABLE_VALUE`, `EVIDENCE_HIDDEN` or `CONFLICTING_EVIDENCE`. Gaps are reviewable and never carried over. |
| **Evidence / quote** | The passage the model cited. It must appear verbatim (after whitespace normalization) in the version's parsed text, and the typed value must lie inside the quote span. |
| **Canonical evidence** | The full stored line(s) the chosen quote touches, normalized. This is what carry-over compares. |
| **Weak line** | A canonical line with no letters left after removing the value tokens (for example a bare `$275.00`). This applies only to date, money, number and percent fields; it never carries alone. |
| **Typed value** | The canonical JSON form: string, `YYYY-MM-DD`, `{amount, currency}`, or a canonical decimal string. |
| **Review** | An append-only human decision on a value: `approve`, `correct` (with `corrected_value`, an annotation beside the extracted value) or `revert` (back to pending). |
| **Current review** | `extracted_values.current_review_id`, the projection that decides the review state. |
| **Review state** | `pending` (no review, or a revert), `approved`, `corrected` or `carried_over`. These buckets are disjoint. |
| **Effective value** | `correctedValue ?? value`. |
| **Baseline** | For a new version, the highest earlier **extracted** version. Values are compared against it field by field. |
| **Change kind** | `new`, `same` or `changed` versus the baseline, plus a `change_reason` when changed. Classification is independent of reviews. |
| **Carry-over** | Copying the baseline's review (`origin='carried'`) onto a `same` value. Requires a non-revert baseline review. Defined by rule **A′**. |
| **Attention** | Display grouping: `changed` → `gap` → `pending` → `done`. |
| **Pending count** | `documents.pending_count`, an index key for the "needs review" filter. Progress shown to users is always computed from source rows. |
| **Soft delete** | `documents.deleted_at`. Deleting revokes the fence on in-flight work. Every route under a deleted document returns 410. Restore re-queues the affected versions. |
| **Idempotency key** | The client's `Idempotency-Key` header. It is stored with the resource in the same tx, and a replay returns the stored result. |
