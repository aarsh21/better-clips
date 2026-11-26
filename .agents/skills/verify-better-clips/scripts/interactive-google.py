#!/usr/bin/env python3
"""Use the repo's Google fake with a bounded Studio propagation delay for UI polling."""
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path('web/worker/tests').resolve()))
import youtube_local as google


class DelayedReads(dict):
    def __setitem__(self, key, old):
        super().__setitem__(key, (time.monotonic() + 2, old))

    def get(self, key):
        until, old = super().get(key, (0, []))
        return old if time.monotonic() < until else None

    def __getitem__(self, key):
        return super().__getitem__(key)[1]


# The protocol exercise polls explicitly; the UI polls on the Worker's real clock.
# Serve the old metadata briefly, then the fake's actual PUT result, not a seeded row.
google.stale_reads = DelayedReads()
with google.ThreadingHTTPServer(('127.0.0.1', 9393), google.Google) as server:
    server.serve_forever()
