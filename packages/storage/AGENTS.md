# packages/storage (`@app/storage`)

S3 `BlobStore` over `@aws-sdk/client-s3` (plus an in-memory store for unit tests).

## Rules
- Never import `@nestjs/*`.
- Always configure S3 with `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'`, and `responseChecksumValidation: 'WHEN_REQUIRED'` (spec §10.2).
- Keys are content-hash-based only (never embed raw filenames in S3 keys).
- Treat `BucketAlreadyOwnedByYou` on bucket bootstrap as success (Task 0 verified fact).
- Use `nodenext` ESM with `.js` relative imports.
