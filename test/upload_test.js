'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {after, before, beforeEach, describe, test} = require('node:test');
const {run} = require('../scripts/upload');

const NOW = new Date('2026-10-16T23:30:00Z');
const BATCH = {id: '01927b2e-7a10-7cc3-8d2a-5b0f6f1f2a01', generated: false, createdBy: 'ci-sub', uploader: 'ci'};

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({server, url: `http://127.0.0.1:${server.address().port}`});
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function field(body, name) {
  return body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`))?.[1];
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Collects the workflow commands run() prints, so annotations can be asserted.
async function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

// Hooks sit inside describe(): Node 20 runs root-level before() after the first beforeEach().
describe('upload-resource', () => {
  let tempDir;
  let token;
  let resource;
  let tokenRequests;
  let uploads;
  // Answers an upload from {body, filename, contents}; tests swap it out.
  let respond;

  function accept({body, filename, contents}) {
    const id = `id-${uploads.length}`;
    return [201, {
      id,
      filename,
      version: field(body, 'version') ?? null,
      sha256: sha256(contents),
      batch: {...BATCH, name: field(body, 'batchName')},
    }];
  }

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-resource-'));
    await fs.mkdir(path.join(tempDir, 'dist'));
    await fs.writeFile(path.join(tempDir, 'artifact.txt'), 'hello');
    await fs.writeFile(path.join(tempDir, 'dist', 'b.bin'), 'bee');
    await fs.writeFile(path.join(tempDir, 'dist', 'a.bin'), 'ay');
    await fs.writeFile(path.join(tempDir, 'dist', 'notes.md'), 'skip me');
    await fs.mkdir(path.join(tempDir, 'dist', 'dir.bin'));

    token = await listen(async (request, response) => {
      tokenRequests += 1;
      const body = (await readBody(request)).toString();
      assert.match(body, /grant_type=client_credentials/);
      assert.match(body, /client_id=ci/);
      response.writeHead(200, {'content-type': 'application/json'});
      response.end('{"access_token":"exchanged-token"}');
    });

    resource = await listen(async (request, response) => {
      const body = (await readBody(request)).toString('latin1');
      const upload = {
        authorization: request.headers.authorization,
        body,
        filename: body.match(/filename="([^"]+)"/)?.[1],
        contents: body.match(/filename="[^"]+"\r\nContent-Type: [^\r]+\r\n\r\n([^\r]*)\r\n/)?.[1],
      };
      uploads.push(upload);
      const [status, json, headers = {}] = respond(upload);
      const text = typeof json === 'string' ? json : JSON.stringify(json);
      response.writeHead(status, {'content-type': 'application/json', ...headers});
      response.end(text);
    });
  });

  after(async () => {
    await Promise.all([close(token.server), close(resource.server)]);
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  beforeEach(async () => {
    tokenRequests = 0;
    uploads = [];
    respond = accept;
    await fs.writeFile(path.join(tempDir, 'outputs.txt'), '');
    await fs.writeFile(path.join(tempDir, 'summary.md'), '');
    Object.assign(process.env, {
      'INPUT_FILE': path.join(tempDir, 'artifact.txt'),
      'INPUT_FILENAME': '',
      'INPUT_RESOURCE-TYPE': 'driver',
      'INPUT_BATCH-NAME': '',
      'INPUT_VERSION': '1.0.0',
      'INPUT_METADATA': '{"platform":"control4"}',
      'INPUT_RELEASE-ACTION': '',
      'INPUT_FLAG': '',
      'INPUT_PROVIDER': '',
      'INPUT_PROJECT': '',
      'INPUT_API-BASE-URL': `${resource.url}/`,
      'INPUT_CLIENT-ID': 'ci',
      'INPUT_CLIENT-SECRET': 'shh',
      'INPUT_TOKEN-URL': token.url,
      'INPUT_RETRIES': '1',
      GITHUB_REPOSITORY: 'snap-one/upload-resource',
      GITHUB_OUTPUT: path.join(tempDir, 'outputs.txt'),
      GITHUB_STEP_SUMMARY: path.join(tempDir, 'summary.md'),
    });
  });

  async function outputs() {
    const text = await fs.readFile(process.env.GITHUB_OUTPUT, 'utf8');
    return Object.fromEntries([...text.matchAll(/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2\n/gm)].map((match) => [match[1], match[3]]));
  }

  test('single file joins the daily batch, retries, authenticates, and sets outputs', async () => {
    respond = (upload) => uploads.length === 1 ? [500, {error: 'retry me'}] : accept(upload);
    process.env.INPUT_FILENAME = 'renamed.txt';

    await run({now: NOW});

    assert.equal(tokenRequests, 1);
    assert.equal(uploads.length, 2);
    const [, upload] = uploads;
    assert.equal(upload.authorization, 'Bearer exchanged-token');
    assert.equal(upload.filename, 'renamed.txt');
    assert.equal(field(upload.body, 'resourceType'), 'driver');
    assert.equal(field(upload.body, 'metadata'), '{"platform":"control4"}');
    assert.equal(field(upload.body, 'batchName'), 'upload-resource-2026-10-16-driver');

    const out = await outputs();
    assert.equal(out['resource-id'], 'id-2');
    assert.equal(out['resource-version'], '1.0.0');
    assert.equal(JSON.parse(out.response).id, 'id-2');
    assert.equal(out['batch-id'], BATCH.id);
    assert.equal(out['batch-name'], 'upload-resource-2026-10-16-driver');
    assert.deepEqual(JSON.parse(out['resource-ids']), ['id-2']);
    assert.deepEqual(JSON.parse(out.responses).map(({id}) => id), ['id-2']);
    assert.equal(out.sha256, sha256('hello'));
  });

  test('an explicit batch-name is trimmed and overrides the default', async () => {
    process.env['INPUT_BATCH-NAME'] = '  release-train-42  ';
    await run({now: NOW});
    assert.equal(field(uploads[0].body, 'batchName'), 'release-train-42');
  });

  test('a batch-name over 128 characters fails before uploading', async () => {
    process.env['INPUT_BATCH-NAME'] = 'é'.repeat(129);
    await assert.rejects(run({now: NOW}), /batch-name must be at most 128 characters, got 129/);
    process.env['INPUT_BATCH-NAME'] = 'é'.repeat(128);
    await run({now: NOW});
    assert.equal(uploads.length, 1);
  });

  test('the default batch name needs GITHUB_REPOSITORY', async () => {
    delete process.env.GITHUB_REPOSITORY;
    await assert.rejects(run({now: NOW}), /GITHUB_REPOSITORY is not set/);
    assert.equal(uploads.length, 0);
  });

  test('several paths and wildcards upload sequentially into one batch', async () => {
    process.env.INPUT_FILE = [
      path.join(tempDir, 'artifact.txt'),
      '',
      `  ${path.join(tempDir, 'dist', '*.bin')}  `,
      path.join(tempDir, 'dist', 'a.*'),
    ].join('\n');

    await run({now: NOW});

    assert.deepEqual(uploads.map(({filename}) => filename), ['artifact.txt', 'a.bin', 'b.bin']);
    assert.deepEqual(new Set(uploads.map(({body}) => field(body, 'batchName'))), new Set(['upload-resource-2026-10-16-driver']));
    const out = await outputs();
    assert.deepEqual(JSON.parse(out['resource-ids']), ['id-1', 'id-2', 'id-3']);
    assert.deepEqual(JSON.parse(out.responses).map(({filename}) => filename), ['artifact.txt', 'a.bin', 'b.bin']);
    assert.equal(out['resource-id'], 'id-1');

    const summary = await fs.readFile(process.env.GITHUB_STEP_SUMMARY, 'utf8');
    assert.match(summary, new RegExp(`Batch \\[upload-resource-2026-10-16-driver\\]\\(${resource.url}/admin/resources\\?view=pre-release&group=batch&batch=${BATCH.id}\\)`));
    assert.match(summary, /\| File \| Version \| Admission \|/);
    assert.match(summary, /\| a\.bin \| 1\.0\.0 \| - \|/);
    assert.equal(summary.match(/^\| .* \| 1\.0\.0 \|/gm).length, 3);
  });

  test('a pattern that matches nothing fails before uploading', async () => {
    process.env.INPUT_FILE = `${path.join(tempDir, 'artifact.txt')}\n${path.join(tempDir, 'dist', '*.zip')}`;
    await assert.rejects(run({now: NOW}), /file pattern matched no files: .*\*\.zip/);
    process.env.INPUT_FILE = path.join(tempDir, 'missing', '*.bin');
    await assert.rejects(run({now: NOW}), /file pattern matched no files/);
    process.env.INPUT_FILE = path.join(tempDir, '*', 'a.bin');
    await assert.rejects(run({now: NOW}), /only supported in the last path segment/);
    assert.equal(uploads.length, 0);
  });

  test('filename is refused when several files match', async () => {
    process.env.INPUT_FILE = path.join(tempDir, 'dist', '*.bin');
    process.env.INPUT_FILENAME = 'renamed.bin';
    await assert.rejects(run({now: NOW}), /filename can only be set for a single file, but file matched 2/);
    assert.equal(uploads.length, 0);
  });

  test('a SHA-256 mismatch fails the step but still reports the stored resource', async () => {
    respond = (upload) => {
      const [status, json] = accept(upload);
      return [status, {...json, sha256: sha256('something else')}];
    };
    await assert.rejects(run({now: NOW}), new RegExp(`stored SHA-256 ${sha256('something else')}, but the local file's is ${sha256('hello')}`));
    assert.equal((await outputs())['resource-id'], 'id-1');
  });

  test('admission warnings become annotations and the verdict reaches the summary', async () => {
    respond = (upload) => {
      const [status, json] = accept(upload);
      return [status, {...json, admission: {verdict: 'pass', findings: [
        {severity: 'warning', code: 'c4.icon.small', message: 'icon is 16px', path: '/icons/a.png'},
        {severity: 'info', code: 'c4.note', message: 'just saying', path: ''},
      ]}}];
    };
    const lines = await captureLog(() => run({now: NOW}));
    assert.deepEqual(lines.filter((line) => line.startsWith('::warning::')), [
      '::warning::artifact.txt: warning c4.icon.small: icon is 16px (at /icons/a.png)',
    ]);
    assert.match(await fs.readFile(process.env.GITHUB_STEP_SUMMARY, 'utf8'), /\| artifact\.txt \| 1\.0\.0 \| pass \|/);
  });

  test('an admission rejection prints each finding', async () => {
    respond = () => [422, {
      error: {code: 'ADMISSION_REJECTED', message: 'upload rejected by admission plugin (2 findings)'},
      attemptId: '01a0db9b-77e7-7ce0-bfae-42a732d5082e',
      admission: {
        verdict: 'fail',
        findings: [
          {severity: 'error', code: 'c4.manufacturer.missing', message: 'devicedata has no manufacturer', path: '/devicedata/manufacturer'},
          {severity: 'warning', code: 'c4.icon.small', message: 'icon is 16px', path: ''},
        ],
        plugin: {resourceId: 'p', filename: 'drivers-validator.wasm', version: '1.4.0', sha256: '9f2c'},
        evaluatedAt: '2026-09-25T18:00:00Z',
      },
    }];
    await assert.rejects(run({now: NOW}), (error) => {
      assert.equal(error.message, [
        'Resource upload of artifact.txt failed with HTTP 422: rejected by admission plugin drivers-validator.wasm 1.4.0 (attempt 01a0db9b-77e7-7ce0-bfae-42a732d5082e) with 2 finding(s):',
        '  error c4.manufacturer.missing: devicedata has no manufacturer (at /devicedata/manufacturer)',
        '  warning c4.icon.small: icon is 16px',
      ].join('\n'));
      return true;
    });
    assert.equal(uploads.length, 1);
  });

  test('a 401 explains the Keycloak basic scope', async () => {
    respond = () => [401, {error: {code: 'UNAUTHORIZED', message: 'token has no subject'}}];
    await assert.rejects(run({now: NOW}), /HTTP 401: .*token has no subject[\s\S]*Keycloak "basic" client scope/);
  });

  test('release-action release is blocked', async () => {
    process.env['INPUT_RELEASE-ACTION'] = 'release';
    await assert.rejects(run({now: NOW}), /release is not permitted/);
    assert.equal(tokenRequests, 0);
  });

  test('Cloudflare error pages are summarized with their Ray ID', async () => {
    // Trimmed from a real WAF block of a .dmg upload.
    respond = () => [403, '<!DOCTYPE html>\n<html><head><title>Attention Required! | Cloudflare</title></head><body>\n'
      + '<div id="cf-error-details" class="cf-error-details-wrapper">\n'
      + '<h1 data-translate="block_headline">Sorry, you have been blocked</h1>\n'
      + '<span class="cf-footer-item">Cloudflare Ray ID: <strong class="font-semibold">a45d56505fd66300</strong></span>\n'
      + '</div></body></html>', {'content-type': 'text/html', 'cf-ray': 'a45d56505fd66300-IAD'}];
    await assert.rejects(run({now: NOW}), (error) => {
      assert.match(error.message, /^Resource upload of artifact\.txt failed with HTTP 403: Sorry, you have been blocked \(Cloudflare Ray ID a45d56505fd66300-IAD\)/);
      assert.doesNotMatch(error.message, /<html/);
      return true;
    });
  });
});
