#!/usr/bin/env bash
# Self-check: exercises scripts/upload.sh against a local mock server for the success and failure paths.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8891
tmpfile=$(mktemp)
echo hello >"$tmpfile"
out=$(mktemp)

start_mock() {
  # Only set MOCK_BODY when given: an empty exported value beats python's os.environ.get default.
  if [[ -n "${2:-}" ]]; then
    MOCK_STATUS="$1" MOCK_BODY="$2" python3 test/mock_server.py "$PORT" &
  else
    MOCK_STATUS="$1" python3 test/mock_server.py "$PORT" &
  fi
  server_pid=$!
  sleep 0.5
}

# Success path
start_mock 201
FILE_PATH="$tmpfile" RESOURCE_TYPE=driver API_BASE_URL="http://127.0.0.1:$PORT" \
  API_TOKEN=test-token RETRIES=1 GITHUB_OUTPUT="$out" scripts/upload.sh
kill "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null || true

grep -q '^resource-id=abc123$' "$out"
grep -q '^resource-version=1.0.0$' "$out"
echo "PASS: success path sets resource-id and resource-version"

# Failure path
start_mock 500 '{"error":"boom"}'
if FILE_PATH="$tmpfile" RESOURCE_TYPE=driver API_BASE_URL="http://127.0.0.1:$PORT" \
  API_TOKEN=test-token RETRIES=1 GITHUB_OUTPUT="$out" scripts/upload.sh >/tmp/upload_test_err.log 2>&1; then
  echo "FAIL: expected a non-2xx response to fail the script"
  kill "$server_pid" 2>/dev/null || true
  exit 1
fi
kill "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null || true

grep -q '500' /tmp/upload_test_err.log
echo "PASS: 500 response fails the script with status in the error"
