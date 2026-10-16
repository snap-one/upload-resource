'use strict';

const fs = require('node:fs/promises');
const {createReadStream, openAsBlob} = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');

// The resource-repository batch name column's width, in characters.
const MAX_BATCH_NAME_LENGTH = 128;

function input(name, required = false) {
  const normalized = name.toUpperCase();
  const value = process.env[`INPUT_${normalized}`]
    || process.env[`INPUT_${normalized.replaceAll('-', '_')}`]
    || '';
  if (required && !value) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return value;
}

function workflowCommand(name, value) {
  const escaped = String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
  console.log(`::${name}::${escaped}`);
}

async function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    workflowCommand(`set-output name=${name}`, value);
    return;
  }

  const delimiter = `ghadelimiter_${randomUUID()}`;
  await fs.appendFile(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function shouldRetry(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function requestWithRetries(url, options, retries, operation) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (!shouldRetry(response.status) || attempt === retries) {
        return response;
      }
      await response.arrayBuffer();
      lastError = new Error(`${operation} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        break;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * 2 ** attempt, 5000)));
  }

  throw new Error(`${operation} failed after ${retries} retries: ${lastError.message}`);
}

// Cloudflare's own error pages (WAF blocks, 52x) are ~80 lines of HTML whose only
// useful part is the Ray ID the zone admin needs to find the rule that fired.
// Origin errors also carry a cf-ray header, so key off the page markup instead.
function describeCloudflareError(response, body) {
  if (!body.includes('cf-error-details')) return null;
  const rayId = response.headers.get('cf-ray') || body.match(/Ray ID: <strong[^>]*>([^<]+)/)?.[1] || 'unknown';
  const reason = body.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1] || body.match(/<title>([^<]+)<\/title>/)?.[1] || 'Cloudflare error page';
  return `${reason.trim()} (Cloudflare Ray ID ${rayId}). Cloudflare stopped the request before it reached the service; look up the Ray ID in the zone's Security > Events to see which rule fired.`;
}

function formatFinding(finding) {
  return `${finding.severity} ${finding.code}: ${finding.message}${finding.path ? ` (at ${finding.path})` : ''}`;
}

function explainUploadFailure(status, body) {
  if (status === 401) {
    return `${body}\nThe API refused the token. This usually means the OIDC client lacks the Keycloak "basic" client scope, so its token carries no "sub" claim; ask whoever administers Keycloak clients to add that scope.`;
  }
  if (status !== 422) return null;
  let rejection;
  try {
    rejection = JSON.parse(body);
  } catch {
    return null;
  }
  const admission = rejection?.admission;
  if (!Array.isArray(admission?.findings)) return null;
  const plugin = [admission.plugin?.filename, admission.plugin?.version].filter(Boolean).join(' ');
  return [
    `rejected by admission plugin ${plugin} (attempt ${rejection.attemptId}) with ${admission.findings.length} finding(s):`,
    ...admission.findings.map((finding) => `  ${formatFinding(finding)}`),
  ].join('\n');
}

async function parseJsonResponse(response, operation, explainFailure = () => null) {
  const body = await response.text();
  if (!response.ok) {
    const detail = describeCloudflareError(response, body) ?? explainFailure(response.status, body) ?? body;
    throw new Error(`${operation} failed with HTTP ${response.status}: ${detail}`);
  }

  try {
    return {body, json: JSON.parse(body)};
  } catch {
    throw new Error(`${operation} returned invalid JSON: ${body}`);
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// `file` takes one path per line. Node 20 has no fs.glob, so `*` is matched
// by hand against a directory listing, and only in the last path segment.
async function expandFiles(spec) {
  const files = [];
  for (const pattern of spec.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const dir = path.dirname(pattern);
    const base = path.basename(pattern);
    if (dir.includes('*')) {
      throw new Error(`file: wildcards are only supported in the last path segment: ${pattern}`);
    }
    if (!base.includes('*')) {
      files.push(pattern);
      continue;
    }
    const regex = new RegExp(`^${base.split('*').map(escapeRegExp).join('.*')}$`);
    const entries = await fs.readdir(dir, {withFileTypes: true}).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const matches = entries
      .filter((entry) => entry.isFile() && regex.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort();
    if (matches.length === 0) {
      throw new Error(`file pattern matched no files: ${pattern}`);
    }
    files.push(...matches);
  }
  if (files.length === 0) {
    throw new Error('Input required and not supplied: file');
  }
  return [...new Set(files)];
}

// One batch per repo, UTC day and resource type: a batch holds one type, and
// batches are owned by the uploading client, so the repo keeps names apart.
function defaultBatchName(resourceType, now) {
  const repo = process.env.GITHUB_REPOSITORY?.split('/').pop();
  if (!repo) {
    throw new Error('GITHUB_REPOSITORY is not set, so there is no default batch name; set batch-name');
  }
  return `${repo}-${now.toISOString().slice(0, 10)}-${resourceType}`;
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeResults(results, apiBaseUrl) {
  const [first] = results;
  const batch = first.json.batch ?? {};
  await setOutput('resource-id', first.json.id ?? '');
  await setOutput('resource-version', first.json.version ?? '');
  await setOutput('response', first.body);
  await setOutput('batch-id', batch.id ?? '');
  await setOutput('batch-name', batch.name ?? '');
  await setOutput('resource-ids', JSON.stringify(results.map(({json}) => json.id)));
  await setOutput('responses', JSON.stringify(results.map(({json}) => json)));
  await setOutput('sha256', first.sha256);

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  const cell = (value) => String(value ?? '-').replaceAll('|', '\\|');
  const batchLink = batch.id
    ? `Batch [${cell(batch.name)}](${apiBaseUrl}/admin/resources?view=pre-release&group=batch&batch=${encodeURIComponent(batch.id)})`
    : 'The API returned no batch.';
  await fs.appendFile(summaryFile, [
    '### Uploaded resources',
    '',
    batchLink,
    '',
    '| File | Version | Admission |',
    '|---|---|---|',
    ...results.map(({name, json}) => `| ${cell(name)} | ${cell(json.version)} | ${cell(json.admission?.verdict)} |`),
    '',
  ].join('\n'));
}

async function run({now = new Date()} = {}) {
  const fileSpec = input('FILE', true);
  const resourceType = input('RESOURCE-TYPE', true);
  const apiBaseUrl = input('API-BASE-URL', true);
  const clientId = input('CLIENT-ID', true);
  const clientSecret = input('CLIENT-SECRET', true);
  const tokenUrl = input('TOKEN-URL', true);
  const releaseAction = input('RELEASE-ACTION');
  const retriesInput = input('RETRIES') || '3';
  const retries = Number.parseInt(retriesInput, 10);

  workflowCommand('add-mask', clientSecret);

  if (!Number.isInteger(retries) || retries < 0) {
    throw new Error(`retries must be a non-negative integer, got: ${retriesInput}`);
  }
  if (releaseAction === 'release') {
    throw new Error('release-action: release is not permitted from this action — promote to production via the Resource Repository admin UI instead');
  }

  const files = await expandFiles(fileSpec);
  const filename = input('FILENAME');
  if (filename && files.length > 1) {
    throw new Error(`filename can only be set for a single file, but file matched ${files.length}`);
  }
  const batchName = input('BATCH-NAME').trim() || defaultBatchName(resourceType, now);
  if ([...batchName].length > MAX_BATCH_NAME_LENGTH) {
    throw new Error(`batch-name must be at most ${MAX_BATCH_NAME_LENGTH} characters, got ${[...batchName].length}: ${batchName}`);
  }

  const tokenBody = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });
  const tokenResponse = await requestWithRetries(tokenUrl, {
    method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: tokenBody,
  }, retries, 'Token exchange request');
  const {json: tokenJson} = await parseJsonResponse(tokenResponse, 'Token exchange');
  const apiToken = tokenJson.access_token;
  if (typeof apiToken !== 'string' || !apiToken) {
    throw new Error('Token exchange response did not contain an access_token');
  }
  workflowCommand('add-mask', apiToken);

  const baseUrl = apiBaseUrl.replace(/\/$/, '');
  const results = [];
  try {
    for (const filePath of files) {
      const name = filename || path.basename(filePath);
      const sha256 = await sha256File(filePath);
      const form = new FormData();
      form.append('file', await openAsBlob(filePath), name);
      form.append('resourceType', resourceType);
      form.append('batchName', batchName);

      for (const [inputName, fieldName] of [
        ['VERSION', 'version'],
        ['METADATA', 'metadata'],
        ['RELEASE-ACTION', 'releaseAction'],
        ['FLAG', 'flag'],
        ['PROVIDER', 'provider'],
        ['PROJECT', 'project'],
      ]) {
        const value = input(inputName);
        if (value) form.append(fieldName, value);
      }

      const uploadResponse = await requestWithRetries(`${baseUrl}/api/v1/resources`, {
        method: 'POST',
        headers: {authorization: `Bearer ${apiToken}`},
        body: form,
      }, retries, `Resource upload request for ${name}`);
      const {body, json} = await parseJsonResponse(uploadResponse, `Resource upload of ${name}`, explainUploadFailure);
      // Stored even when the check below fails, so outputs still name it for cleanup.
      results.push({name, sha256, body, json});

      if (json.sha256 && json.sha256.toLowerCase() !== sha256) {
        throw new Error(`Resource upload of ${name} stored SHA-256 ${json.sha256}, but the local file's is ${sha256}`);
      }
      for (const finding of json.admission?.findings ?? []) {
        if (finding.severity === 'warning') workflowCommand('warning', `${name}: ${formatFinding(finding)}`);
      }
      console.log(`Uploaded ${name} as ${json.id} into batch ${json.batch?.name ?? batchName}`);
    }
  } finally {
    if (results.length > 0) await writeResults(results, baseUrl);
  }
}

if (require.main === module) {
  run().catch((error) => {
    workflowCommand('error', error.message);
    process.exitCode = 1;
  });
}

module.exports = {run, requestWithRetries};
