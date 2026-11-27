# ESM everywhere, Nest built with SWC and bundler resolution

Every package and app is native ESM, because unpdf is ESM-only and requires Node ≥ 24. Shared packages use `nodenext`. The Nest apps use the SWC builder with `moduleResolution: bundler`, because under `nodenext` the Swagger CLI plugin emits invalid `require(…, {with})` metadata. A spike verified DI, Swagger with `loadPluginMetadata`, Vitest with unplugin-swc, and `pnpm deploy`.

**Considered options:** CJS Nest plus `await import()` for ESM packages (dual formats); dual CJS/ESM builds via tshy.
