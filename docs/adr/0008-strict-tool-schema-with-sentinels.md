# Strict tool use with a sentinel schema, never nullable types

Extraction uses forced `tool_choice` with `strict: true` (stable on Sonnet 5.5). Strict mode allows at most 16 union-typed parameters per request, and we need about 4 per field, so the schema has **no nullable or union types**. Absent values are `found=false` with `""` or `-1` sentinels, and `core` maps them back to nulls. Bounds the strict grammar rejects (`maxItems`, `minLength`, …) are enforced in zod after parsing. Raw bodies are read with `.asResponse()` and stored before validation.

**Considered options:** nullable unions (exceed the budget past about 4 fields); strict off (more repair calls); Citations API (Anthropic-only, and its offsets don't match our stored text).
