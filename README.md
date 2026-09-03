# upload-resource

Reusable GitHub Action that uploads a build artifact to the
[Resource Repository](https://github.com/snap-one/resource-repository) API
(`POST /api/v1/resources`), so consuming repos don't each hand-roll their own
curl/auth/retry step.

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
    api-token: ${{ secrets.RESOURCE_REPOSITORY_TOKEN }}

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
    api-token: ${{ secrets.RESOURCE_REPOSITORY_TOKEN }}
```

## Inputs

| Name | Required | Description |
|---|---|---|
| `file` | yes | Path to the file to upload |
| `resource-type` | yes | `resourceType` field |
| `version` | no | Resource version |
| `metadata` | no | Metadata as a JSON string |
| `release-action` | no | `release`, `reject`, `feature_flag`, or `feature_flag_variation`. Omitted defaults to beta (`ManualApproval`). |
| `flag` | no | Feature flag name — required when `release-action` is `feature_flag`/`feature_flag_variation` |
| `provider` | no | Feature flag provider (e.g. `launchdarkly`, `split`) — required with the flag actions above |
| `project` | no | Provider project identifier, scoping flag targeting rules |
| `api-base-url` | yes | Base URL of the Resource Repository API |
| `api-token` | yes | API token — pass via `secrets`, never hardcode |
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
test/upload_test.sh
```

Runs the action's upload logic against a local mock server (success + 500
paths). CI runs the same script on every push/PR.
