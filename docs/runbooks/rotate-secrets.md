# Runbook: rotate secrets

| Secret | Used by | Rotate |
|---|---|---|
| `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | worker only | Update the env/secret, then restart the worker. In-flight runs fail transiently and are retried by the sweep. |
| `POSTGRES_APP_PASSWORD` / `POSTGRES_MIGRATOR_PASSWORD` | api+worker / migrate | `ALTER ROLE … PASSWORD …`, update `DATABASE_URL` / `DATABASE_MIGRATOR_URL`, restart the services |
| `REDIS_PASSWORD` | api, worker, redis | Update the env, then restart redis, api and worker. The queue rebuilds from Postgres. |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | api, worker, migrate | Update `infra/seaweedfs/s3.json` and the env, then restart |

In production these come from the secret manager. Booting with a known dev default under
`APP_ENV=production` is refused by the config denylist.
