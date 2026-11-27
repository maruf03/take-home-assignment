# Runbook: PDF parse failures

| Code | Cause | Retry helps? | Action |
|---|---|---|---|
| `PARSE_NO_TEXT` | Scanned/image-only PDF (no text layer) | No | OCR isn't supported yet. Ask for a text PDF. |
| `PARSE_ENCRYPTED` | Password-protected | No | Ask for an unencrypted file. |
| `PARSE_MALFORMED` | Corrupt or invalid PDF | No | Re-export the PDF. |
| `PARSE_LIMIT_EXCEEDED` | More than 200 pages, more than 2M chars, more than 50k items/page, or the RSS watchdog fired | No | Split the document. |
| `PARSE_TIMEOUT` | Parse took more than 30s (child killed) | Maybe | Retry once; if it repeats, treat as limit exceeded. |
| `PARSE_CRASHED` | Child exited unexpectedly | Maybe | Retry; check worker logs for the child's stderr. |
| `INTEGRITY_MISMATCH` | Stored object's sha256 ≠ recorded | No | Storage corruption. Re-upload the file as a new version. |

The parse pool restarts children automatically, so the worker process itself survives every one of these.
