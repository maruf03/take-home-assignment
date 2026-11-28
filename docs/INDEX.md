# Documentation index

One map for humans and agents. Docs are organised by purpose: explanation, reference, how-to and
runbooks, after [Diátaxis](https://diataxis.fr). Start with the root [README](../README.md);
agents start with [AGENTS.md](../AGENTS.md).

| Status | Meaning |
|---|---|
| ✅ | Written |
| 🧭 | Planned (see the named plan task; secondary docs moved to Extended E1d) |

## Start here
| Doc | For | Status |
|---|---|---|
| [README.md](../README.md) | What it is, how to run it, decisions, cuts | ✅ |
| [BRIEF.md](../BRIEF.md) | The original assignment brief, verbatim | ✅ |
| [AGENTS.md](../AGENTS.md) / [CLAUDE.md](../CLAUDE.md) | Agent instructions, commands, non-negotiables | ✅ |
| [GLOSSARY.md](../GLOSSARY.md) | Domain language | ✅ |

## Design and plans
| Doc | Status |
|---|---|
| [Design spec v5](superpowers/specs/2026-11-27-document-review-design.md), the source of truth | ✅ |
| [Plan: Core tier](superpowers/plans/2026-11-27-core-tier.md) | ✅ |
| [Plan: Extended tier](superpowers/plans/2026-11-27-extended-tier.md) | ✅ |
| [history/](history/): PLAN-v0…v4, the debate trail behind the spec | ✅ (frozen) |
| [history/spike-results.md](history/spike-results.md): Task 0 live verification evidence (Gemini, Docker, SeaweedFS) | ✅ |

## Explanation (why it works this way)
| Doc | Status |
|---|---|
| [architecture.md](explanation/architecture.md): components, the Postgres/Redis/S3 split, failure matrix | ✅ (summary; detail in the spec §2–3) |
| extraction-core.md: parsing, evidence rules, carry-over A′ with the fixture proof | 🧭 Extended E1d |
| concurrency.md: lock order, fencing, checkpoints | 🧭 Extended E1d |
| security.md: threat model, controls, residual risks | 🧭 Extended E1d |

## Decisions: [adr/](adr/)
| ADR | Decision |
|---|---|
| [0001](adr/0001-postgres-version-status-is-the-outbox.md) | Version status is the outbox |
| [0002](adr/0002-run-id-fencing-token-with-postgres-lease.md) | Run-id fencing, Postgres-time leases |
| [0003](adr/0003-carry-over-rule-a-prime.md) | Carry-over rule A′ |
| [0004](adr/0004-jsonb-values-with-shape-checks-generated-migrations.md) | jsonb + shape CHECKs; generated migrations only |
| [0005](adr/0005-db-privileges-enforce-append-only-and-no-delete.md) | DB privileges enforce append-only and no delete |
| [0006](adr/0006-soft-delete-aggregate-root-410.md) | Soft delete on the aggregate root; 410 *(Extended E1a)* |
| [0007](adr/0007-parse-in-child-process-pool.md) | Child-process parse pool + RSS watchdog |
| [0008](adr/0008-strict-tool-schema-with-sentinels.md) | Strict tool schema with sentinels |
| [0009](adr/0009-esm-everywhere-nest-swc-bundler.md) | ESM everywhere; Nest via SWC + bundler resolution |
| [0010](adr/0010-keyset-pagination-on-uuidv7.md) | Keyset pagination on uuidv7 |
| [0011](adr/0011-review-revert-is-an-append-only-decision.md) | Undo is a revert review |
| [0012](adr/0012-pdf-original-rendered-with-pdfjs-canvas.md) | Original PDF via pdf.js canvas *(Extended E1c)* |

## Reference
| Doc | Status |
|---|---|
| [traceability.md](reference/traceability.md): requirement → tests | ✅ |
| [openapi.json](reference/openapi.json): OpenAPI spec generated from API Swagger decorators | ✅ |
| api.md (human-friendly API guide) | 🧭 Extended E1d |
| schema.md (tables, constraints, grants) | 🧭 Extended E1d |
| error-codes.md (problem codes, version failure codes, gap codes, change reasons, UI copy) | 🧭 Extended E1d |
| configuration.md (every env var, default, and production denylist) | 🧭 Extended E1d |

## How-to
| Doc | Status |
|---|---|
| [local-development.md](how-to/local-development.md) | ✅ |
| [git-workflow.md](how-to/git-workflow.md): branches, Conventional Commits, PRs, hooks | ✅ |
| testing.md (tiers, isolation, fakes, chaos) | 🧭 Extended E1d |
| update-goldens.md | 🧭 Extended E1d |
| record-cassettes.md | 🧭 Extended E1d |
| add-document-type.md (templates and hints) | 🧭 Extended E1d |
| deploy.md | 🧭 Extended E11 (lowest priority) |

## Runbooks: [runbooks/](runbooks/)
[stuck-extraction](runbooks/stuck-extraction.md) · [redis-flush-recovery](runbooks/redis-flush-recovery.md) ·
[llm-outage](runbooks/llm-outage.md) · [parser-failures](runbooks/parser-failures.md) ·
[restore-deleted-document](runbooks/restore-deleted-document.md) · [rotate-secrets](runbooks/rotate-secrets.md)

## Agent setup
[agents/issue-tracker.md](agents/issue-tracker.md) · [agents/domain.md](agents/domain.md)

## Submission
[submission.md](submission.md): repo, session-log gist, video and deploy links.
