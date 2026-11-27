# Lomi Labs --- Senior Full Stack Engineer Take-Home

## Engineering Plan · Iteration 1

> **Purpose:** First implementation plan for the take-home assignment.
> This document focuses on the product and engineering work only.
> Submission logistics and explanation-video preparation are
> intentionally excluded.
>
> **Deadline in assignment:** Saturday, 28 November 2026, 23:59 UTC
> (Sunday, 29 November, 05:59 Bangladesh time).

## 1. Goal and scope

Build a small, reliable application that:

1.  Ingests a PDF document.
2.  Extracts expected fields using an LLM.
3.  Validates each field's evidence against the exact parsed text of
    that document version.
4.  Lets a reviewer approve or correct every extracted value.
5.  Accepts revised documents while preserving earlier versions and
    reviews.
6.  Carries reviews forward only when the field's evidence is unchanged.
7.  Recovers safely from worker crashes, retries, and Redis data loss.

The assignment prioritizes a smaller, well-finished implementation over
a broad, incomplete one.

## 2. Proposed technology stack

  -----------------------------------------------------------------------
  Area                    Choice                  Reason
  ----------------------- ----------------------- -----------------------
  Monorepo                pnpm workspaces +       Clear package
                          Turborepo               boundaries and real
                                                  build/test/lint
                                                  pipeline

  API                     Node.js + TypeScript +  Lightweight, typed HTTP
                          Fastify                 API

  UI                      React + Vite +          Straightforward
                          TypeScript              reviewer interface

  Database                PostgreSQL              Durable system of
                                                  record

  Queue                   Redis + BullMQ          Background extraction
                                                  and retries

  PDF parsing             A maintained Node PDF   Extract text for
                          text extraction library evidence checks

  LLM                     Provider with           Predictable extraction
                          structured output       response shape

  Local environment       Docker Compose          One command starts the
                                                  full system
  -----------------------------------------------------------------------

Keep the implementation as a modular monolith with a separate worker
process. Do not add microservices, Kubernetes, authentication, or
elaborate frontend infrastructure for this assignment.

## 3. Monorepo structure

``` text
/
├── apps/
│   ├── api/                 # HTTP API and request validation
│   ├── worker/              # BullMQ extraction worker
│   └── web/                 # React reviewer UI
├── packages/
│   ├── database/             # Schema, migrations, DB access
│   └── shared/               # Shared types and validation schemas
├── fixtures/
│   └── ...                   # Assignment-provided fixtures
├── docker-compose.yml
├── turbo.json
├── pnpm-workspace.yaml
└── README.md
```

The Turborepo pipeline should genuinely run `build`, `test`, and `lint`
across the relevant workspaces, with dependency ordering where needed.

## 4. System architecture

``` mermaid
flowchart TB
    Reviewer[Reviewer] --> Web[React + Vite UI]
    Web --> API[Fastify API]

    API --> PG[(PostgreSQL)]
    API --> Redis[(Redis + BullMQ)]

    PG --> Outbox[Durable outbox]
    Outbox --> Dispatcher[Outbox dispatcher]
    Dispatcher --> Redis

    Redis --> Worker[Extraction worker]
    Worker --> PDF[PDF text parser]
    PDF --> LLM[Structured-output LLM]
    LLM --> Validator[Evidence validator]
    Validator --> PG

    Recovery[Recovery / reconciliation] --> PG
    Recovery --> Redis
```

**Core principle:** PostgreSQL is the system of record. Redis
coordinates work but is not the only place where pending work or
user-visible outcomes exist.

## 5. Data model

Proposed entities:

  -----------------------------------------------------------------------
  Table                               Responsibility
  ----------------------------------- -----------------------------------
  `documents`                         Stable document identity, type,
                                      title, current version

  `document_versions`                 Version number, file location,
                                      parsed text, extraction status

  `extraction_runs`                   Attempts, prompt, raw LLM response,
                                      errors, timestamps

  `extracted_values`                  Field key, value or gap, evidence,
                                      evidence fingerprint

  `reviews`                           Approval or correction, corrected
                                      value, note, timestamp

  `outbox_events`                     Durable event waiting to be
                                      delivered to the queue
  -----------------------------------------------------------------------

### Relationships

``` mermaid
erDiagram
    DOCUMENTS ||--o{ DOCUMENT_VERSIONS : has
    DOCUMENT_VERSIONS ||--o{ EXTRACTION_RUNS : attempts
    DOCUMENT_VERSIONS ||--o{ EXTRACTED_VALUES : contains
    EXTRACTED_VALUES ||--o{ REVIEWS : receives
    DOCUMENTS ||--o{ OUTBOX_EVENTS : emits

    DOCUMENTS {
        uuid id PK
        string type
        string title
        int current_version
    }

    DOCUMENT_VERSIONS {
        uuid id PK
        uuid document_id FK
        int version_number
        string status
        string file_location
        text parsed_text
    }

    EXTRACTION_RUNS {
        uuid id PK
        uuid document_version_id FK
        string status
        text prompt
        json raw_response
        text error_message
    }

    EXTRACTED_VALUES {
        uuid id PK
        uuid document_version_id FK
        string field_key
        json value
        text evidence
        string evidence_fingerprint
        string gap_reason
    }

    REVIEWS {
        uuid id PK
        uuid extracted_value_id FK
        string decision
        json corrected_value
        text note
    }

    OUTBOX_EVENTS {
        uuid id PK
        uuid document_id FK
        string event_type
        json payload
        string delivery_status
    }
```

### Data integrity rules

-   Each extracted value belongs to exactly one document version.
-   Preserve all document versions and their reviews.
-   Use a uniqueness constraint on `(document_version_id, field_key)` so
    a retry cannot create duplicate field values.
-   Review history should be append-only where practical; do not destroy
    the earlier decision when a correction is made.
-   Store parsed text per version so historical evidence remains
    verifiable after later uploads.
-   Keep extraction prompts and raw provider responses for debugging, as
    required by the brief.

## 6. Upload and extraction lifecycle

### Upload flow

``` mermaid
sequenceDiagram
    actor User
    participant API
    participant DB as PostgreSQL
    participant Outbox
    participant Dispatcher
    participant Redis
    participant Worker

    User->>API: POST /documents (PDF + type)
    API->>DB: Create document + version
    API->>Outbox: Insert extraction event
    DB-->>API: Commit transaction
    API-->>User: Return document ID + queued status

    Dispatcher->>Outbox: Read undelivered events
    Dispatcher->>Redis: Enqueue BullMQ job
    Redis-->>Dispatcher: Job accepted
    Dispatcher->>Outbox: Mark event delivered

    Redis->>Worker: Deliver extraction job
    Worker->>DB: Mark version extracting
    Worker->>Worker: Parse PDF and call LLM
    Worker->>DB: Persist validated values + outcome
    Worker->>DB: Mark version extracted
```

The API must not wait for PDF parsing or the LLM. It should return as
soon as the database transaction commits.

### Transactional outbox

Avoid this unsafe sequence:

1.  Save a document in PostgreSQL.
2.  Enqueue a Redis job.
3.  Redis fails before the job is created.

Instead, create the document/version and its outbox event in the same
PostgreSQL transaction. A dispatcher retries delivery until Redis
accepts the job.

Queue delivery may happen more than once, so the worker must be
idempotent.

## 7. Failure handling and recovery

The system must remain recoverable when Redis is flushed or a worker
dies.

``` mermaid
stateDiagram-v2
    [*] --> queued
    queued --> extracting
    extracting --> extracted
    extracting --> failed
    failed --> queued: Retry
    extracting --> queued: Lease expired / recovery
    queued --> [*]
    extracted --> [*]
    failed --> [*]
```

### Recovery approach

-   Store extraction status and durable outcomes in PostgreSQL.
-   Use a lease, heartbeat, or timestamp to identify abandoned
    `extracting` work.
-   On startup, reconcile database state with the queue.
-   Re-enqueue eligible `queued` work.
-   Move abandoned extraction attempts back to a retryable state.
-   Redis flush must not delete extracted values, reviews, or visible
    job outcomes.
-   A failure must be represented in the document/version state and be
    retryable.

### Idempotent worker behavior

1.  Claim the extraction attempt.
2.  Parse the PDF.
3.  Request structured extraction from the LLM.
4.  Validate all evidence.
5.  Persist results transactionally.
6.  Mark the version complete.
7.  Acknowledge the queue job.

If the worker crashes after persistence but before acknowledgement, the
retry must not duplicate values.

## 8. LLM extraction and evidence validation

For each document type, use the assignment's `expected-fields.json` as
the source of expected fields.

The LLM response should provide, for every expected field:

-   Field key
-   Extracted value, or null
-   Exact evidence quote
-   Gap reason when the field cannot be found

### Validation rules

  -----------------------------------------------------------------------
  Condition                           Stored result
  ----------------------------------- -----------------------------------
  Evidence appears verbatim in parsed Store extracted value and evidence
  text                                

  Field is not found                  `value = null` and a reason

  Evidence is absent                  Gap

  Evidence does not appear verbatim   Gap; do not retain the unverified
                                      value

  PDF parsing or LLM call fails       Extraction attempt failed; document
                                      remains retryable
  -----------------------------------------------------------------------

Do not treat model confidence as proof. The quote must be checked
against the parsed text for the exact version being extracted.

## 9. Re-extraction and review carry-over

### Evidence fingerprint

Use a conservative fingerprint per field:

`field_key + normalized_evidence`

Normalization should be limited to safe transformations such as
whitespace and line-break normalization. Preserve meaningful
punctuation, symbols, and numbers.

Do not compare the entire document text: unrelated changes can shift the
document and make unchanged evidence appear different.

### Carry-over decision

``` mermaid
flowchart TD
    Start[Extract field in new version] --> HasOld{Previous field exists?}
    HasOld -- No --> Pending[Create pending review]
    HasOld -- Yes --> Same{Evidence fingerprint unchanged?}
    Same -- Yes --> Carry[Carry previous review]
    Same -- No --> Changed[Create pending value]
    Changed --> ShowPrevious[Show previous value and review]
```

Rules:

-   Same evidence fingerprint: carry forward the prior approval or
    correction and mark it carried over.
-   Changed evidence: new value is pending; show the previous value and
    review.
-   Same extracted value but changed evidence: do **not** carry the
    review.
-   Preserve the old version and its review records.

### New version during extraction

Chosen behavior: accept the new upload and queue it behind the current
version.

-   Maintain monotonically increasing version numbers.
-   Avoid concurrent extraction of versions belonging to the same
    document.
-   Ensure the newer version does not overwrite the older version's
    status or results.
-   Document this policy in the README.

## 10. API surface

  ---------------------------------------------------------------------------
  Method                  Endpoint                    Purpose
  ----------------------- --------------------------- -----------------------
  `POST`                  `/documents`                Upload PDF and create
                                                      first version

  `POST`                  `/documents/:id/versions`   Upload revised PDF

  `GET`                   `/documents/:id`            Document, current
                                                      version, status, values

  `POST`                  `/values/:id/review`        Approve or correct a
                                                      value

  `GET`                   `/documents/:id/progress`   Pending, approved,
                                                      corrected, carried-over
                                                      counts

  `GET`                   `/documents/:id/progress`   Poll progress while
                                                      extraction/review is
                                                      underway
  ---------------------------------------------------------------------------

Use consistent response shapes and request validation. Review
corrections should require a corrected value and optionally accept a
note.

## 11. Review UI

Build two primary screens.

### Document list

Show:

-   Document title and type
-   Current version
-   Extraction status
-   Pending review count
-   Approved / corrected count
-   Failed or retryable status

### Document detail / review

For each field, show:

-   Field name
-   Extracted value
-   Exact source quote
-   Review state
-   Approve action
-   Correct action
-   Gap reason, if applicable

After re-extraction, distinguish carried-over values from newly pending
values. Changed fields should display the previous value and previous
review alongside the new extraction.

Use simple polling rather than streaming unless implementation time
allows. The key UX goal is that a reviewer can identify what needs
attention within a few seconds.

## 12. Docker Compose and seed behavior

At the repository root, `docker compose up` should start:

-   PostgreSQL
-   Redis
-   API
-   Worker
-   Web UI

Startup should run migrations and seed version 1 of the supplied sample
documents. The invoice's version 2 should remain available for the
reviewer to upload and test re-extraction, as specified in the
assignment.

Use a persistent volume for PostgreSQL and a local volume or simple
storage abstraction for uploaded PDFs.

## 13. Test priorities

Focus tests on failure-prone behavior.

  -----------------------------------------------------------------------
  Test                                Expected result
  ----------------------------------- -----------------------------------
  Upload responds before LLM          Immediate queued response
  completes                           

  Redis unavailable during upload     Outbox event remains durable

  Redis `FLUSHALL`                    Work is recovered; no data/review
                                      loss

  Worker crashes after persistence    Retry does not duplicate values

  Invalid evidence quote              Stored as gap

  Missing LLM field                   Gap with reason

  Unchanged evidence in revised PDF   Review carried over

  Changed evidence in revised PDF     Field becomes pending

  Historical version queried after    Old values and reviews remain
  newer upload                        available

  New version uploaded during         Accepted and processed in order
  extraction                          
  -----------------------------------------------------------------------

Mock the LLM in most automated tests. Add a small integration test with
the chosen provider if time permits.

## 14. Implementation sequence

### Phase 1 --- Foundation

-   Initialize pnpm workspace and Turborepo.
-   Create API, worker, web, database, and shared packages.
-   Configure `build`, `test`, and `lint` pipelines.
-   Set up Docker Compose and database migrations.

### Phase 2 --- Durable ingestion

-   Implement document and version records.
-   Implement PDF upload and file storage.
-   Add transactional outbox and dispatcher.
-   Confirm upload returns immediately.

### Phase 3 --- Extraction worker

-   Implement queue processing and status transitions.
-   Parse PDF text and call the structured-output LLM.
-   Validate evidence and represent gaps.
-   Persist prompt, raw response, and extraction outcome.
-   Add retry and idempotency behavior.

### Phase 4 --- Recovery

-   Add abandoned-job detection.
-   Add startup reconciliation and Redis-flush recovery.
-   Test worker termination and queue loss.

### Phase 5 --- Versioning and carry-over

-   Upload a revised document.
-   Compare field evidence fingerprints.
-   Carry unchanged reviews forward.
-   Reset changed evidence to pending.
-   Preserve historical values and reviews.

### Phase 6 --- Reviewer UI

-   Document list and status.
-   Document detail and evidence.
-   Approve/correct actions.
-   Gaps and prior-version comparison.

### Phase 7 --- Hardening

-   Add high-priority tests.
-   Verify the supplied revised invoice.
-   Confirm root `docker compose up` works from a clean state.
-   Write the engineering README, including decisions and limitations.

## 15. Deliberate cuts

If time becomes constrained, cut these first:

1.  Quote highlighting within the document text.
2.  Elaborate visual styling.
3.  Streaming updates; polling is sufficient.
4.  Multiple LLM providers.
5.  Complex file storage infrastructure.
6.  User accounts and permissions.

Do not cut:

-   PostgreSQL durability
-   Redis-backed job queue
-   Outbox/recovery behavior
-   Idempotency
-   Evidence validation
-   Historical versions and reviews
-   Review carry-over

## 16. Open decisions to resolve during implementation

-   Exact PDF parser and its text normalization behavior.
-   LLM provider/model and structured-output schema.
-   Local file storage layout.
-   Lease/heartbeat interval and abandoned-job timeout.
-   Whether review history is append-only or has a current-review
    projection.
-   Exact status representation for a version with some gaps.
-   How progress counts treat carried-over reviews.

Record the chosen answers and trade-offs in the README. Keep the
implementation small enough that every important behavior can be
explained and tested.
