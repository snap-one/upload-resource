# upload-resource

Reusable GitHub Action that uploads a build artifact to the
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

- run: echo "Uploaded ${{ steps.upload.outputs.resource-id }} v${{ steps.upload.outputs.resource-version }}"
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

Ask whoever administers Keycloak clients for `client-id`/`client-secret` — a
confidential, client-credentials-only client scoped `resources:write` (see
[resource-repository's Keycloak requirements doc](https://github.com/snap-one/resource-repository/blob/main/docs/keycloak-requirements.md)).
`token-url` defaults to the shared realm every environment uses, so you don't
need to know it — only set it if your client lives elsewhere.

## Inputs

| Name | Required | Description |
|---|---|---|
| `file` | yes | Path to the file to upload |
| `filename` | no | Upload the file as this name instead of its local name |
| `resource-type` | yes | `resourceType` field |
| `version` | no | Resource version |
| `metadata` | no | Metadata as a JSON string |
| `release-action` | no | `reject`, `feature_flag`, or `feature_flag_variation`. Omitted defaults to beta (`ManualApproval`). **`release` (immediate production release) is rejected by this action** — promote via the admin UI instead. |
| `flag` | no | Feature flag name — required when `release-action` is `feature_flag`/`feature_flag_variation` |
| `provider` | no | Feature flag provider (e.g. `launchdarkly`, `split`) — required with the flag actions above |
| `project` | no | Provider project identifier, scoping flag targeting rules |
| `api-base-url` | yes | Base URL of the Resource Repository API |
| `client-id` | yes | OIDC client ID for the client-credentials grant this action exchanges for a bearer token before upload |
| `client-secret` | yes | OIDC client secret — pass via `secrets`, never hardcode |
| `token-url` | no | OIDC token endpoint to exchange at. Defaults to the shared realm all environments use — override only if your client lives elsewhere. |
| `retries` | no | Retry attempts for transient network/5xx failures (default `3`) |

## Outputs

| Name | Description |
|---|---|
| `resource-id` | ID of the created resource |
| `resource-version` | Version of the created resource |
| `response` | Full JSON response body |

On any non-2xx response the step fails with the HTTP status and response body.
The token is masked via `::add-mask::` before the request runs, so it never
appears in logs.

## Using this from git.control4.com (GHES)

This repo is public specifically so GitHub Connect can proxy it into
`git.control4.com` — a private repo isn't reachable that way. If a consuming
repo there can't resolve `uses: snap-one/upload-resource@v1`, ask your GHES
admin to confirm "Actions using GitHub Connect" is enabled and, if an actions
allowlist policy is in effect, that this repo is on it.

## Development

```bash
node test/upload_test.js
```

Runs the action's upload logic against local mock servers, including success,
retry, authentication, filename override, output, and blocked-release paths.
CI runs the same test on every push/PR.
