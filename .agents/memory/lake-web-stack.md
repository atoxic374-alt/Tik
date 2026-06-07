---
name: LAKE Web Stack
description: Architecture decisions for the LAKE TikTok username tool web app
---

## Stack
- Flask + Flask-SocketIO (async_mode='eventlet') on port 5000
- eventlet.monkey_patch() at top of server.py — required for WebSocket support
- pip install (not nix): flask, flask-socketio, eventlet, aiohttp, requests

## Key pattern
Async checker runs via `asyncio.run()` inside `threading.Thread(daemon=True)`.
socketio.emit() is thread-safe with eventlet mode.

**Why:** Werkzeug dev server doesn't support WebSocket upgrade; eventlet handles it.

## State reset
_reset_state() clears hits/stats/ip/counter before each run.

## Auto-claim flow
deep_check → DeepChecker.start() → cb() per result → if _auto_claim: _run_claim(u) per available username.

## Known TikTok API codes
- 0: success, 8/10003/10115: session invalid, 10105/10106: 30d cooldown,
- 10108/10109: username taken, 10101-10104: captcha, 4/10000: rate limit

## How to get TikTok sessionid
Browser → DevTools → Application → Cookies → www.tiktok.com → sessionid value
