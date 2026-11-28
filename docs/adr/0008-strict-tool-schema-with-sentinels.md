# Strict tool use with a sentinel schema, never nullable types

Extraction uses strict structured outputs with **no nullable or union types** across providers: Gemini (`gemini-3.5-flash`, default) uses `responseMimeType: 'application/json'`, `responseJsonSchema`, and `httpOptions.fetch` response capture, while Anthropic (`claude-sonnet-5-5`) uses forced `tool_choice` with `strict: true` (at most 16 union-typed parameters per request) and `.asResponse()`. Absent values are `found=false` with `""` or `-1` sentinels, and `core` maps them back to nulls. Bounds rejected by strict grammars (`maxItems`, `minLength`, …) are enforced in zod after parsing, and raw provider bodies are stored before validation.

**Considered options:** nullable unions (exceed the budget past about 4 fields); strict off (more repair calls); Citations API (Anthropic-only, and its offsets don't match our stored text).
