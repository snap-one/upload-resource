#!/usr/bin/env bash
set -euo pipefail

# Mask immediately so the token never appears in logs even on an unexpected failure path below.
echo "::add-mask::${API_TOKEN}"

response_file=$(mktemp)
args=(-sS -o "$response_file" -w '%{http_code}' \
  --retry "${RETRIES:-3}" --retry-connrefused --retry-all-errors \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -F "file=@${FILE_PATH}" \
  -F "resourceType=${RESOURCE_TYPE}")

[[ -n "${VERSION:-}" ]] && args+=(-F "version=${VERSION}")
[[ -n "${METADATA:-}" ]] && args+=(-F "metadata=${METADATA}")

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
