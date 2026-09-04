#!/usr/bin/env bash
# Self-check: exercises scripts/upload.sh against local mock servers for the token
# exchange and the resource upload, covering the success and failure paths.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8891
TOKEN_PORT=8892
tmpfile=$(mktemp)
echo hello >"$tmpfile"
out=$(mktemp)

start_mock() {
  # port, status, body(optional). Only set MOCK_BODY when given: an empty
  # exported value beats python's os.environ.get default.
  #
  # Redirect the server's own stdout/stderr: this function is always called
  # as $(start_mock ...), and a backgrounded child that keeps the command
  # substitution's stdout pipe open never lets that pipe see EOF — the
  # long-running mock server would hang the $(...) forever otherwise.
  if [[ -n "${3:-}" ]]; then
    MOCK_STATUS="$2" MOCK_BODY="$3" python3 test/mock_server.py "$1" >/dev/null 2>&1 &
  else
    MOCK_STATUS="$2" python3 test/mock_server.py "$1" >/dev/null 2>&1 &
  fi
  echo $!
}

start_token_mock() {
  start_mock "$TOKEN_PORT" 200 '{"access_token":"exchanged-token"}'
}

common_env=(FILE_PATH="$tmpfile" RESOURCE_TYPE=driver
  API_BASE_URL="http://127.0.0.1:$PORT" CLIENT_ID=ci CLIENT_SECRET=shh
  TOKEN_URL="http://127.0.0.1:$TOKEN_PORT" RETRIES=1 GITHUB_OUTPUT="$out")

# Success path
token_pid=$(start_token_mock); sleep 0.5
resource_pid=$(start_mock "$PORT" 201); sleep 0.5
env "${common_env[@]}" scripts/upload.sh
kill "$token_pid" "$resource_pid" 2>/dev/null; wait "$token_pid" "$resource_pid" 2>/dev/null || true

grep -q '^resource-id=abc123$' "$out"
grep -q '^resource-version=1.0.0$' "$out"
echo "PASS: success path sets resource-id and resource-version"

# Resource upload failure path
token_pid=$(start_token_mock); sleep 0.5
resource_pid=$(start_mock "$PORT" 500 '{"error":"boom"}'); sleep 0.5
if env "${common_env[@]}" scripts/upload.sh >/tmp/upload_test_err.log 2>&1; then
  echo "FAIL: expected a non-2xx response to fail the script"
  kill "$token_pid" "$resource_pid" 2>/dev/null || true
  exit 1
fi
kill "$token_pid" "$resource_pid" 2>/dev/null; wait "$token_pid" "$resource_pid" 2>/dev/null || true

grep -q '500' /tmp/upload_test_err.log
echo "PASS: 500 response fails the script with status in the error"

# Token exchange failure path
token_pid=$(start_mock "$TOKEN_PORT" 401 '{"error":"invalid_client"}'); sleep 0.5
if env "${common_env[@]}" scripts/upload.sh >/tmp/upload_test_err.log 2>&1; then
  echo "FAIL: expected a failed token exchange to fail the script"
  kill "$token_pid" 2>/dev/null || true
  exit 1
fi
kill "$token_pid" 2>/dev/null; wait "$token_pid" 2>/dev/null || true

grep -q 'Token exchange failed' /tmp/upload_test_err.log
echo "PASS: a failed token exchange fails the script before any upload is attempted"

# release-action=release must be rejected before any network call is made.
if RELEASE_ACTION=release env "${common_env[@]}" scripts/upload.sh >/tmp/upload_test_err.log 2>&1; then
  echo "FAIL: expected release-action=release to be rejected"
  exit 1
fi
grep -q 'not permitted' /tmp/upload_test_err.log
echo "PASS: release-action=release is rejected"

# The exchanged token — not some stale/wrong value — is what reaches the resource endpoint.
captured=$(mktemp)
token_pid=$(start_token_mock); sleep 0.5
resource_pid=$(CAPTURE_AUTH_HEADER_FILE="$captured" start_mock "$PORT" 201); sleep 0.5
env "${common_env[@]}" scripts/upload.sh
kill "$token_pid" "$resource_pid" 2>/dev/null; wait "$token_pid" "$resource_pid" 2>/dev/null || true

grep -q '^Bearer exchanged-token$' "$captured"
echo "PASS: the exchanged token is used against the resource endpoint"
