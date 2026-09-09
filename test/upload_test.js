'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {run} = require('../scripts/upload');

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

async function main() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-resource-'));
  const filePath = path.join(tempDir, 'artifact.txt');
  const outputPath = path.join(tempDir, 'outputs.txt');
  await fs.writeFile(filePath, 'hello');
  await fs.writeFile(outputPath, '');

  let tokenRequests = 0;
  const token = await listen(async (request, response) => {
    tokenRequests += 1;
    const body = (await readBody(request)).toString();
    assert.match(body, /grant_type=client_credentials/);
    assert.match(body, /client_id=ci/);
    response.writeHead(200, {'content-type': 'application/json'});
    response.end('{"access_token":"exchanged-token"}');
  });

  let uploadRequests = 0;
  let capturedAuthorization = '';
  let capturedBody = '';
  const resource = await listen(async (request, response) => {
    uploadRequests += 1;
    capturedAuthorization = request.headers.authorization;
    capturedBody = (await readBody(request)).toString();
    if (uploadRequests === 1) {
      response.writeHead(500);
      response.end('{"error":"retry me"}');
      return;
    }
    response.writeHead(201, {'content-type': 'application/json'});
    response.end('{"id":"abc123","version":"1.0.0"}');
  });

  Object.assign(process.env, {
    'INPUT_FILE': filePath,
    'INPUT_FILENAME': 'renamed.txt',
    'INPUT_RESOURCE-TYPE': 'driver',
    'INPUT_VERSION': '1.0.0',
    'INPUT_METADATA': '{"platform":"control4"}',
    'INPUT_RELEASE-ACTION': '',
    'INPUT_FLAG': '',
    'INPUT_PROVIDER': '',
    'INPUT_PROJECT': '',
    'INPUT_API-BASE-URL': resource.url,
    'INPUT_CLIENT-ID': 'ci',
    'INPUT_CLIENT-SECRET': 'shh',
    'INPUT_TOKEN-URL': token.url,
    'INPUT_RETRIES': '1',
    GITHUB_OUTPUT: outputPath,
  });

  try {
    await run();
    assert.equal(tokenRequests, 1);
    assert.equal(uploadRequests, 2);
    assert.equal(capturedAuthorization, 'Bearer exchanged-token');
    assert.match(capturedBody, /filename="renamed.txt"/);
    assert.match(capturedBody, /name="resourceType"\r\n\r\ndriver/);
    assert.match(capturedBody, /name="metadata"\r\n\r\n\{"platform":"control4"\}/);

    const outputs = await fs.readFile(outputPath, 'utf8');
    assert.match(outputs, /resource-id<<[^\n]+\nabc123\n/);
    assert.match(outputs, /resource-version<<[^\n]+\n1\.0\.0\n/);
    assert.match(outputs, /response<<[^\n]+\n\{"id":"abc123","version":"1\.0\.0"\}\n/);

    process.env['INPUT_RELEASE-ACTION'] = 'release';
    await assert.rejects(run(), /release is not permitted/);
    console.log('PASS: upload succeeds, retries transient failures, authenticates, and sets outputs');
  } finally {
    await Promise.all([close(token.server), close(resource.server)]);
    await fs.rm(tempDir, {recursive: true, force: true});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
