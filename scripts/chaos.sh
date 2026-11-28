#!/usr/bin/env bash
# Runs the serial chaos test suite against isolated redis-chaos on 127.0.0.1:6380
# (spec §10.6, §11.3, Core Task 12).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

TEARDOWN=0
if [[ "${1:-}" == "--down" || "${CHAOS_TEARDOWN:-0}" == "1" ]]; then
  TEARDOWN=1
fi

cleanup() {
  if [[ "$TEARDOWN" == "1" ]]; then
    docker compose -f compose.yaml -f compose.dev.yaml -f compose.test.yaml down
  fi
}
trap cleanup EXIT

echo "Starting infra + redis-chaos (127.0.0.1:6380)..."
docker compose -f compose.yaml -f compose.dev.yaml -f compose.test.yaml up -d --wait

export APP_ENV=test
export REDIS_CHAOS_URL="${REDIS_CHAOS_URL:-redis://:dev-redis@127.0.0.1:6380}"

echo "Running chaos tests (SIGKILL mid-LLM + Redis FLUSHALL recovery)..."
pnpm test:chaos
