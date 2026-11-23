"""Static server that also records benchmark results.

    python3 tools/bench.py [port]

Open http://localhost:<port>/dist/web/index.html?bench in any browser; each
finished run is appended to bench-results.jsonl next to this folder and printed.
"""
import http.server, json, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'bench-results.jsonl')

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def do_POST(self):
        if self.path != '/bench':
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)) or 0)
        try:
            data = json.loads(body)
        except ValueError:
            self.send_error(400)
            return
        with open(OUT, 'a') as f:
            f.write(json.dumps(data) + '\n')
        print('BENCH', json.dumps(data), flush=True)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *a):
        pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8125
http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
