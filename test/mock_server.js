'use strict';

const fs = require('node:fs');
const http = require('node:http');

const status = Number.parseInt(process.env.MOCK_STATUS || '201', 10);
const body = process.env.MOCK_BODY || '{"id":"abc123","version":"1.0.0"}';

http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    if (process.env.CAPTURE_AUTH_HEADER_FILE) {
      fs.writeFileSync(process.env.CAPTURE_AUTH_HEADER_FILE, request.headers.authorization || '');
    }
    if (process.env.CAPTURE_BODY_FILE) {
      fs.writeFileSync(process.env.CAPTURE_BODY_FILE, Buffer.concat(chunks));
    }
    response.writeHead(status, {'content-length': Buffer.byteLength(body)});
    response.end(body);
  });
}).listen(Number.parseInt(process.argv[2], 10), '127.0.0.1');
