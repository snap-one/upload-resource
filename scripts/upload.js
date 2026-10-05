'use strict';

const fs = require('node:fs/promises');
const {openAsBlob} = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

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

async function parseJsonResponse(response, operation) {
  const body = await response.text();
  if (!response.ok) {
    const detail = describeCloudflareError(response, body) ?? body;
    throw new Error(`${operation} failed with HTTP ${response.status}: ${detail}`);
  }

  try {
    return {body, json: JSON.parse(body)};
  } catch {
    throw new Error(`${operation} returned invalid JSON: ${body}`);
  }
}

async function run() {
  const filePath = input('FILE', true);
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

  const file = await openAsBlob(filePath);
  const form = new FormData();
  form.append('file', file, input('FILENAME') || path.basename(filePath));
  form.append('resourceType', resourceType);

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

  const uploadUrl = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/resources`;
  const uploadResponse = await requestWithRetries(uploadUrl, {
    method: 'POST',
    headers: {authorization: `Bearer ${apiToken}`},
    body: form,
  }, retries, 'Resource upload request');
  const {body, json} = await parseJsonResponse(uploadResponse, 'Resource upload');

  await setOutput('resource-id', json.id ?? '');
  await setOutput('resource-version', json.version ?? '');
  await setOutput('response', body);
}

if (require.main === module) {
  run().catch((error) => {
    workflowCommand('error', error.message);
    process.exitCode = 1;
  });
}

module.exports = {run, requestWithRetries};
