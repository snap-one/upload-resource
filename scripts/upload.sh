#!/usr/bin/env bash
set -euo pipefail

# Mask immediately so secrets never appear in logs even on an unexpected failure path below.
echo "::add-mask::${CLIENT_SECRET}"

# Immediate production release must go through the management UI, not an automated CI step.
if [[ "${RELEASE_ACTION:-}" == "release" ]]; then
  echo "::error::release-action: release is not permitted from this action — promote to production via the Resource Repository admin UI instead"
  exit 1
fi

token_response_file=$(mktemp)
set +e
token_status=$(curl -sS -o "$token_response_file" -w '%{http_code}' \
  --retry "${RETRIES:-3}" --retry-connrefused --retry-all-errors \
  -d grant_type=client_credentials \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  "${TOKEN_URL}")
token_curl_exit=$?
set -e

token_body=$(cat "$token_response_file")

if [[ $token_curl_exit -ne 0 ]]; then
  echo "::error::Token exchange request failed (curl exit ${token_curl_exit}) after ${RETRIES:-3} retries"
  exit 1
fi
if [[ "$token_status" -lt 200 || "$token_status" -ge 300 ]]; then
  echo "::error::Token exchange failed with HTTP ${token_status}: ${token_body}"
  exit 1
fi

API_TOKEN=$(jq -r '.access_token' <<<"$token_body")
echo "::add-mask::${API_TOKEN}"

response_file=$(mktemp)
file_field="file=@${FILE_PATH}"
[[ -n "${FILENAME:-}" ]] && file_field+=";filename=${FILENAME}"

args=(-sS -o "$response_file" -w '%{http_code}' \
  --retry "${RETRIES:-3}" --retry-connrefused --retry-all-errors \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -F "$file_field" \
  -F "resourceType=${RESOURCE_TYPE}")

[[ -n "${VERSION:-}" ]] && args+=(-F "version=${VERSION}")
[[ -n "${METADATA:-}" ]] && args+=(-F "metadata=${METADATA}")
[[ -n "${RELEASE_ACTION:-}" ]] && args+=(-F "releaseAction=${RELEASE_ACTION}")
[[ -n "${FLAG:-}" ]] && args+=(-F "flag=${FLAG}")
[[ -n "${PROVIDER:-}" ]] && args+=(-F "provider=${PROVIDER}")
[[ -n "${PROJECT:-}" ]] && args+=(-F "project=${PROJECT}")

set +e
status=$(curl "${args[@]}" "${API_BASE_URL%/}/api/v1/resources")
curl_exit=$?
set -e

body=$(cat "$response_file")

if [[ $curl_exit -ne 0 ]]; then
  echo "::error::Resource upload request failed (curl exit ${curl_exit}) after ${RETRIES:-3} retries"
  exit 1
fi

if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
  echo "::error::Resource upload failed with HTTP ${status}: ${body}"
  exit 1
fi

resource_id=$(jq -r '.id' <<<"$body")
resource_version=$(jq -r '.version' <<<"$body")

{
  echo "resource-id=${resource_id}"
  echo "resource-version=${resource_version}"
  echo "response<<EOF"
  echo "$body"
  echo "EOF"
} >>"$GITHUB_OUTPUT"
