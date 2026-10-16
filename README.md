# upload-resource

Reusable GitHub Action that uploads build artifacts to the
[Resource Repository](https://github.com/snap-one/resource-repository) API
(`POST /api/v1/resources`), so consuming repos don't each hand-roll their own
auth/retry step. It uses the GitHub Actions-provided Node runtime and requires
no tools or packages to be installed on the runner.

## Usage

```yaml
- name: Upload driver package
  uses: snap-one/upload-resource@v1
  id: upload
  with:
    file: dist/mydriver.c4z
    resource-type: driver
    version: ${{ github.ref_name }}
    metadata: '{"platform":"control4"}'
    api-base-url: https://resources.snapone.com
    client-id: ${{ vars.RESOURCE_REPOSITORY_CLIENT_ID }}
    client-secret: ${{ secrets.RESOURCE_REPOSITORY_CLIENT_SECRET }}

- run: echo "Uploaded ${{ steps.upload.outputs.resource-id }} v${{ steps.upload.outputs.resource-version }} into ${{ steps.upload.outputs.batch-name }}"
```

Uploading several files into one batch, one path per line, with `*` wildcards in the last path segment:

```yaml
- uses: snap-one/upload-resource@v1
  id: upload
  with:
    file: |
      dist/*.c4z
      docs/release-notes.pdf
    resource-type: driver
    version: ${{ github.ref_name }}
    api-base-url: https://resources.snapone.com
    client-id: ${{ vars.RESOURCE_REPOSITORY_CLIENT_ID }}
    client-secret: ${{ secrets.RESOURCE_REPOSITORY_CLIENT_SECRET }}

- env:
    RESOURCE_IDS: ${{ steps.upload.outputs.resource-ids }}
  run: echo "$RESOURCE_IDS" | jq -r '.[]'
```

Gating a release behind a feature flag instead of the default beta (`ManualApproval`) state:

```yaml
- uses: snap-one/upload-resource@v1
  with:
    file: dist/mydriver.c4z
    resource-type: driver
    version: 2.0.0
    release-action: feature_flag_variation
    flag: enable-motion-sensor-v2
    provider: split
    project: home-automation
    api-base-url: https://resources.snapone.com
    client-id: ${{ vars.RESOURCE_REPOSITORY_CLIENT_ID }}
    client-secret: ${{ secrets.RESOURCE_REPOSITORY_CLIENT_SECRET }}
```

Ask whoever administers Keycloak clients for `client-id`/`client-secret`: a
confidential, client-credentials-only client scoped `resources:write`, with the
`basic` client scope so its tokens carry `sub` (see
[resource-repository's Keycloak requirements doc](https://github.com/snap-one/resource-repository/blob/main/docs/keycloak-requirements.md)).
`token-url` defaults to the shared realm every environment uses, so you don't
need to know it. Only set it if your client lives elsewhere.

## Batches

Every upload joins a batch, the group the admin Resources workspace reviews together.
The action sends `batch-name` with every file, and the API joins uploads with the same name, from the same client and of the same resource type, into one batch.

The default name is `<repo name>-<UTC date YYYY-MM-DD>-<resource type>`, for example `mydriver-2026-10-16-driver`.
So every workflow and every run in a repo on the same UTC day lands in one batch per resource type.
The date is UTC, so the day rolls over at 18:00 MDT (17:00 MST), not at local midnight.
The repo is in the name because batches are owned by the client that started them: two repos with different CI clients sharing one name would make the second one fail with `BATCH_NAME_TAKEN`.
The resource type is in the name because a batch holds one type.

Set `batch-name` to choose the batch yourself, for example to put several repos that share one CI client into one batch, or to give each run its own batch with `batch-name: ${{ github.event.repository.name }}-${{ github.run_id }}-driver`.
An empty `batch-name` uses the default; there is no way to ask for a server-generated name.

Batches never close.
A later upload on the same day joins that day's batch even after earlier files in it were released or rejected; the admin Pre-release view shows only the files still waiting.

After the upload, the step summary lists each file with its version and admission verdict, and links the batch in the admin workspace (`<api-base-url>/admin/resources?view=pre-release&group=batch&batch=<batch-id>`).

## Inputs

| Name | Required | Description |
|---|---|---|
| `file` | yes | Path of the file to upload, or several paths one per line. The last path segment may use `*` wildcards. A pattern that matches nothing fails the step. Files upload one after another into the same batch. |
| `filename` | no | Upload the file as this name instead of its local name. Only allowed when `file` names a single file. |
| `resource-type` | yes | `resourceType` field |
| `batch-name` | no | Batch to upload into, trimmed, at most 128 characters. Defaults to `<repo name>-<UTC date>-<resource type>`; see [Batches](#batches). |
| `version` | no | Resource version, applied to every file |
| `metadata` | no | Metadata as a JSON string, applied to every file |
| `release-action` | no | `reject`, `feature_flag`, or `feature_flag_variation`. Omitted defaults to beta (`ManualApproval`). **`release` (immediate production release) is rejected by this action**; promote via the admin UI instead. |
| `flag` | no | Feature flag name, required when `release-action` is `feature_flag`/`feature_flag_variation` |
| `provider` | no | Feature flag provider (e.g. `launchdarkly`, `split`), required with the flag actions above |
| `project` | no | Provider project identifier, scoping flag targeting rules |
| `api-base-url` | yes | Base URL of the Resource Repository API |
| `client-id` | yes | OIDC client ID for the client-credentials grant this action exchanges for a bearer token before upload |
| `client-secret` | yes | OIDC client secret. Pass via `secrets`, never hardcode. |
| `token-url` | no | OIDC token endpoint to exchange at. Defaults to the shared realm all environments use; override only if your client lives elsewhere. |
| `retries` | no | Retry attempts for transient network/5xx failures, per file (default `3`) |

## Outputs

| Name | Description |
|---|---|
| `resource-id` | ID of the created resource (the first file, when several upload) |
| `resource-version` | Version of the created resource (the first file) |
| `response` | Full JSON response body (the first file) |
| `batch-id` | ID of the batch the files joined |
| `batch-name` | Name of the batch the files joined |
| `resource-ids` | JSON array of the created resource IDs, in upload order |
| `responses` | JSON array of the response bodies, in upload order |
| `sha256` | Hex SHA-256 of the uploaded file (the first file) |

If a later file fails, the outputs and step summary still describe the files uploaded before it, so a cleanup step can find them.

## Checks and failures

On any non-2xx response the step fails with the HTTP status and response body.
The token is masked via `::add-mask::` before the request runs, so it never appears in logs.

- **Integrity.** The action hashes each file locally and fails when the API reports a different `sha256` for what it stored.
- **Admission.** When the resource type has an admission plugin, a rejected upload (HTTP 422 `ADMISSION_REJECTED`) fails the step with one line per finding: severity, code, message and path. Warning findings on an accepted upload show as `::warning::` annotations.
- **Cloudflare.** When the response is a Cloudflare error page (for example a WAF block), the step prints its headline and Cloudflare Ray ID instead of the page's HTML.

## Troubleshooting

- **HTTP 401 on upload.** The API needs a `sub` claim in the token. Ask your Keycloak admin to add the `basic` client scope to the client.
- **HTTP 409 `BATCH_NAME_TAKEN`.** Another client started a batch with this name, or the batch holds another resource type. Set a different `batch-name`.
- **`file pattern matched no files`.** Check the path relative to the workspace. Wildcards only work in the last path segment (`dist/*.c4z`, not `*/mydriver.c4z`).
- **Files you did not expect in a batch.** Batches never close, so every run in the repo on the same UTC day joins the same batch. Set `batch-name` per run if you want them apart.

## Using this from git.control4.com (GHES)

This repo is public specifically so GitHub Connect can proxy it into
`git.control4.com`; a private repo isn't reachable that way. If a consuming
repo there can't resolve `uses: snap-one/upload-resource@v1`, ask your GHES
admin to confirm "Actions using GitHub Connect" is enabled and, if an actions
allowlist policy is in effect, that this repo is on it.

## Development

```bash
node test/upload_test.js
```

Runs the action's upload logic against local mock servers, including success,
retry, authentication, batch naming, multi-file and wildcard input, integrity,
admission, step summary, filename override, output, and blocked-release paths.
CI runs the same test on every push/PR.
