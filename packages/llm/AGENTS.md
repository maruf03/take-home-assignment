# packages/llm (`@app/llm`)

`LlmProvider` interface, Gemini (default) and Anthropic adapters, fake/fake-ipc providers, cassette replayer, and pricing table.

## Rules
- Never import `@nestjs/*`.
- Store raw provider response bodies verbatim before validation; disable SDK automatic retries.
- For Anthropic, use `.asResponse()`. For Gemini, use `responseJsonSchema`, `thinkingConfig: { thinkingBudget: 0 }`, and capture raw JSON via `httpOptions` fetch wrapper (`provider_request_id = responseId`).
- Refuse `fake`, `fake-ipc`, and `cassette` providers unless `APP_ENV=test`.
- Never log API keys, prompts, or document text.
- Use `nodenext` ESM with `.js` relative imports.
