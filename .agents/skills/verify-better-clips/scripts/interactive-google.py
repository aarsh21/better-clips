#!/usr/bin/env python3
"""Use the repo's Google fake with a bounded Studio propagation delay for UI polling."""
from pathlib import Path
import os
import sys
import time
from urllib.parse import parse_qs, urlsplit

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
run = Path(os.environ['R'])

class InteractiveGoogle(google.Google):
    def do_GET(self):
        request = urlsplit(self.path)
        if request.path == '/o/oauth2/v2/auth':
            q = parse_qs(request.query)
            direct = q['redirect_uri'][0] != google.BASE + '/api/youtube/callback'
            scopes = sorted(s.removeprefix(google.PREFIX) for s in q['scope'][0].split())
            if (run / 'worker040').exists():
                assert not direct and scopes == ['email', 'force-ssl', 'openid', 'readonly', 'upload']
                assert q['include_granted_scopes'] == ['true']
            else:
                assert scopes == (['readonly', 'upload'] if direct else ['email', 'force-ssl', 'openid'])
                assert 'include_granted_scopes' not in q
            if (run / 'returning-grant').exists():
                google.extra_grants.update({google.PREFIX + 'readonly', google.PREFIX + 'upload'})
            print('Direct' if direct else 'Hosted', scopes, flush=True)
        super().do_GET()

    def reply(self, code=200, data=None, **headers):
        if (run / 'worker040').exists() or (run / 'returning-grant').exists():
            if urlsplit(self.path).path == '/oauth2/v3/userinfo':
                data['sub'] = 'rollout-subject'
            if urlsplit(self.path).path == '/token' and (run / 'returning-grant').exists():
                data.pop('refresh_token', None)  # Google can return only the existing broad access grant.
        override = run / 'google-audience'
        if urlsplit(self.path).path == '/youtube/v3/videos' and self.command == 'GET' and override.exists():
            audience = override.read_text().strip()
            for video in data.get('items', []):
                video['status'] = dict(video['status'])
                if audience == 'unknown':
                    video['status'].pop('madeForKids', None)
                else:
                    video['status']['madeForKids'] = audience == 'kids'
        super().reply(code, data, **headers)

with google.ThreadingHTTPServer(('127.0.0.1', 9393), InteractiveGoogle) as server:
    server.serve_forever()
