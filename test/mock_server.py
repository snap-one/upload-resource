#!/usr/bin/env python3
"""Minimal HTTP server for exercising upload.sh's success/failure paths in tests."""
import http.server
import os
import sys

status = int(os.environ.get("MOCK_STATUS", "201"))
body = os.environ.get("MOCK_BODY", '{"id":"abc123","version":"1.0.0"}').encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
