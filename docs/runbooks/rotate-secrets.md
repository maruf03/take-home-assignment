# Runbook: rotate secrets

| Secret | Used by | Rotate |
|---|---|---|
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | worker only | Update the env/secret, then restart the worker. In-flight runs fail transiently and are retried by the sweep. |
| `APP_DB_PASSWORD` / `MIGRATOR_DB_PASSWORD` | api+worker / migrate | `ALTER ROLE … PASSWORD …`, update the env, restart the services |
| `REDIS_PASSWORD` | api, worker, redis | Update the env, then restart redis, api and worker. The queue rebuilds from Postgres. |
| SeaweedFS S3 keys | api, worker, migrate | Update `s3.json` and the env, then restart |

In production these come from the secret manager. Booting with a known dev default under
`APP_ENV=production` is refused by the config denylist.
