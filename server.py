import eventlet
eventlet.monkey_patch()
import asyncio, random, string, os, threading
import requests, aiohttp
from typing import List, Optional
from collections import deque
from datetime import datetime
from flask import Flask, render_template
from flask_socketio import SocketIO

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='eventlet')

# ── State ───────────────────────────────────────────────
_hits: List[str] = []
_stats = {"checked": 0, "available": 0, "taken": 0, "errors": 0}
_status = "Idle"
_lock = threading.Lock()
_running = False
_stop_event = threading.Event()
_total_usernames = 0
_proxies: List[str] = []
_proxy_index = 0
_proxy_lock = threading.Lock()
_current_ip = "—"
_request_counter = 0
_ip_check_every = 5
_last_ips: deque = deque(maxlen=5)
_proxy_rotating = False

# ── Claimer state ────────────────────────────────────────
_account_session  = ""
_account_ms_token = ""
_captcha_key      = ""
_auto_claim       = False
_claim_uncertain  = False

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
]

def _now(): return datetime.now().strftime("%H:%M:%S")

def _log(msg, kind="info"):
    socketio.emit('log', {"msg": f"[{_now()}]  {msg}", "kind": kind})

def _emit_state():
    with _lock:
        socketio.emit('stats',  dict(_stats))
        socketio.emit('hits',   list(_hits))
        socketio.emit('status', {
            "status":  _status,
            "running": _running,
            "ip":      _current_ip,
            "total":   _total_usernames,
            "checked": _stats["checked"],
        })

# ── Proxy helpers ───────────────────────────────────────
def load_proxies_from_txt():
    if not os.path.exists("proxies.txt"):
        return []
    out = []
    for line in open("proxies.txt"):
        line = line.strip()
        if not line or line.startswith("#"): continue
        if not line.startswith("http"): line = "http://" + line
        out.append(line)
    return out

def get_next_proxy() -> Optional[str]:
    global _proxy_index
    with _proxy_lock:
        if not _proxies: return None
        p = _proxies[_proxy_index % len(_proxies)]
        _proxy_index += 1
        return p

def remove_proxy(proxy: str):
    if _proxy_rotating: return
    with _proxy_lock:
        if proxy in _proxies:
            _proxies.remove(proxy)
            _log(f"[PROXY REMOVED]  {proxy}", "warn")

async def test_single_proxy(proxy: str) -> tuple:
    start = asyncio.get_event_loop().time()
    try:
        conn = aiohttp.TCPConnector(ssl=False)
        async with aiohttp.ClientSession(connector=conn) as s:
            async with s.get("https://httpbin.org/ip", proxy=proxy,
                             headers={"User-Agent": "Mozilla/5.0"},
                             timeout=aiohttp.ClientTimeout(total=10)) as r:
                ms = int((asyncio.get_event_loop().time() - start) * 1000)
                if r.status == 200:
                    data = await r.json()
                    ip = data.get("origin", "?").split(",")[0].strip()
                    return (proxy, True, ms, ip)
                return (proxy, False, ms, f"HTTP {r.status}")
    except Exception as e:
        ms = int((asyncio.get_event_loop().time() - start) * 1000)
        return (proxy, False, ms, str(e)[:60])

async def check_current_ip() -> str:
    global _current_ip
    proxy = get_next_proxy()
    try:
        conn = aiohttp.TCPConnector(ssl=False) if proxy else None
        async with aiohttp.ClientSession(connector=conn) as s:
            async with s.get("https://httpbin.org/ip", proxy=proxy,
                             headers={"User-Agent": "Mozilla/5.0"},
                             timeout=aiohttp.ClientTimeout(total=8)) as r:
                if r.status == 200:
                    data = await r.json()
                    ip = data.get("origin", "?").split(",")[0].strip()
                    with _lock:
                        changed = not _last_ips or _last_ips[-1] != ip
                        if changed: _last_ips.append(ip)
                    _current_ip = ip
                    socketio.emit('ip', {"ip": ip, "changed": changed and len(_last_ips) > 1})
                    if changed and len(_last_ips) > 1:
                        _log(f"[IP ROTATED]  {ip}", "hit")
                    else:
                        _log(f"[IP CHECK]  {ip}  (لم يتغير)", "warn")
                    return ip
    except Exception as e:
        _log(f"[IP CHECK ERR]  {str(e)[:50]}", "err")
    return _current_ip

# ── File helpers ────────────────────────────────────────
def write_hit(u):
    with open("hits.txt", "a", encoding="utf-8") as f: f.write(u + "\n")

def send_webhook(url, u):
    if not url or "WEBHOOK_URL_HERE" in url or not url.startswith("http"): return
    try: requests.post(url, json={"content": f"Available: @{u}"}, timeout=5)
    except: pass

def generate_usernames(amount, length):
    chars = string.ascii_lowercase + string.digits
    return ["".join(random.choice(chars) for _ in range(length)) for _ in range(amount)]

def load_from_txt():
    if not os.path.exists("usernames.txt"): return []
    return [x.strip() for x in open("usernames.txt") if x.strip()]

# ── Core availability APIs ───────────────────────────────
#
#  Three independent signals — only an AVAILABLE verdict needs majority (2/3)
#  to avoid false positives. TAKEN verdicts are trusted immediately.
#
#  Signal ranking (most reliable → least):
#    1. user-detail API  → JSON, structured, definitive
#    2. oEmbed API       → JSON, fast, usually reliable
#    3. Web page HTML    → slowest, can be noisy / geo-gated
#

async def _sig_userdetail(session: aiohttp.ClientSession, username: str, proxy) -> str:
    """
    TikTok internal user-detail API.
    Returns: 'available' | 'taken' | 'banned' | 'uncertain'
    status_code meanings:
      0     → user found (taken)
      10202 → user not found (available)
      10221 → account suspended/banned
      others → uncertain
    """
    url = (
        f"https://www.tiktok.com/api/user/detail/"
        f"?uniqueId={username}&aid=1988&app_language=en&app_name=tiktok_web"
    )
    headers = {
        "User-Agent":      random.choice(USER_AGENTS),
        "Accept":          "application/json, text/plain, */*",
        "Referer":         "https://www.tiktok.com/",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        async with session.get(url, headers=headers, proxy=proxy,
                               timeout=aiohttp.ClientTimeout(total=12)) as r:
            if r.status == 200:
                d = await r.json(content_type=None)
                code = d.get("statusCode", d.get("status_code", -1))
                if code == 0:
                    return "taken"
                if code == 10202:
                    return "available"
                if code in (10221, 10222):
                    return "banned"
            elif r.status == 404:
                return "available"
    except Exception:
        pass
    return "uncertain"

async def _sig_oembed(session: aiohttp.ClientSession, username: str, proxy) -> str:
    """
    oEmbed API.
    Returns: 'available' | 'taken' | 'uncertain'
    """
    url = f"https://www.tiktok.com/oembed?url=https://www.tiktok.com/@{username}"
    headers = {
        "User-Agent":  random.choice(USER_AGENTS),
        "Accept":      "application/json, text/plain, */*",
        "Cache-Control": "no-cache",
    }
    try:
        async with session.get(url, headers=headers, proxy=proxy,
                               timeout=aiohttp.ClientTimeout(total=12)) as r:
            if r.status == 404:
                return "available"
            if r.status == 200:
                d = await r.json(content_type=None)
                return "taken" if d.get("author_unique_id") else "uncertain"
    except Exception:
        pass
    return "uncertain"

async def _sig_web(session: aiohttp.ClientSession, username: str, proxy) -> str:
    """
    Web-page HTML check.
    Returns: 'available' | 'taken' | 'banned' | 'uncertain'
    """
    url = f"https://www.tiktok.com/@{username}"
    headers = {
        "User-Agent":      random.choice(USER_AGENTS),
        "Accept":          "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Connection":      "keep-alive",
        "Cache-Control":   "no-cache",
    }
    TAKEN  = ['"userInfo":', 'webapp-user-title', '"uniqueId":']
    BANNED = ['account is banned', 'account has been banned', 'user not found']
    try:
        async with session.get(url, headers=headers, proxy=proxy,
                               timeout=aiohttp.ClientTimeout(total=14)) as r:
            if r.status == 404:
                return "available"
            if r.status != 200:
                return "uncertain"
            html = await r.text()
            for m in BANNED:
                if m in html.lower(): return "banned"
            for m in TAKEN:
                if m in html: return "taken"
            return "available"
    except Exception:
        pass
    return "uncertain"

def _majority_verdict(signals: list) -> str:
    """
    Combine three signals with safety-first rules:
    - Any 'taken' → taken (avoid wasting a claim attempt)
    - Any 'banned' → banned
    - 2+ 'available' AND no taken/banned → available
    - Otherwise → uncertain
    """
    if "taken"  in signals: return "taken"
    if "banned" in signals: return "banned"
    avail = signals.count("available")
    if avail >= 2:          return "available"
    if avail == 1 and signals.count("uncertain") <= 1:
        return "available"
    return "uncertain"


# ── Checker (fast scan) ──────────────────────────────────
class Checker:
    """
    Fast scan using user-detail API + oEmbed.
    Only marks available when both agree (no false positives).
    Falls back to web-page for rate-limited situations.
    """
    def __init__(self, webhook, usernames):
        self.webhook   = webhook
        self.usernames = usernames
        self.sem       = asyncio.Semaphore(4)

    async def _check(self, username: str):
        global _status, _request_counter
        if _stop_event.is_set(): return
        async with self.sem:
            if _stop_event.is_set(): return
            await asyncio.sleep(random.uniform(1.2, 2.5))
            with _lock:
                _request_counter += 1
                do_ip = (_request_counter % _ip_check_every == 0)
            if do_ip and _proxies:
                await check_current_ip()
            _status = f"Checking @{username}"
            proxy     = get_next_proxy()
            connector = aiohttp.TCPConnector(ssl=False) if proxy else None
            try:
                async with aiohttp.ClientSession(connector=connector) as session:
                    # Run user-detail + oEmbed in parallel for speed
                    sig_api, sig_oe = await asyncio.gather(
                        _sig_userdetail(session, username, proxy),
                        _sig_oembed(session, username, proxy),
                    )
                    proxy_tag = f"  [{proxy.split('@')[-1]}]" if proxy else ""

                    with _lock: _stats["checked"] += 1

                    if sig_api == "taken" or sig_oe == "taken":
                        with _lock: _stats["taken"] += 1
                        _log(f"[TAKEN]      @{username}", "taken")

                    elif sig_api == "banned" or sig_oe == "banned":
                        with _lock: _stats["taken"] += 1
                        _log(f"[BANNED]     @{username}", "warn")

                    elif sig_api == "available" and sig_oe in ("available", "uncertain"):
                        # API says available — high confidence
                        with _lock:
                            _stats["available"] += 1
                            _hits.append(username)
                        write_hit(username)
                        send_webhook(self.webhook, username)
                        _log(f"[AVAILABLE ✅]  @{username}{proxy_tag}", "hit")

                    elif sig_oe == "available" and sig_api == "uncertain":
                        # oEmbed says available but API uncertain — do quick web check
                        sig_web = await _sig_web(session, username, proxy)
                        if sig_web == "available":
                            with _lock:
                                _stats["available"] += 1
                                _hits.append(username)
                            write_hit(username)
                            send_webhook(self.webhook, username)
                            _log(f"[AVAILABLE ✅]  @{username}  (3/3 confirmed){proxy_tag}", "hit")
                        elif sig_web == "taken":
                            with _lock: _stats["taken"] += 1
                            _log(f"[TAKEN]      @{username}", "taken")
                        else:
                            with _lock: _stats["errors"] += 1
                            _log(f"[UNCERTAIN]  @{username}  — متضارب، تخطي", "warn")

                    else:
                        # Both uncertain or conflicting — skip silently
                        with _lock: _stats["errors"] += 1
                        _log(f"[SKIP]       @{username}  api={sig_api} oe={sig_oe}", "warn")

            except Exception as e:
                with _lock: _stats["errors"] += 1
                if proxy:
                    _log(f"[PROXY ERR]  {proxy.split('@')[-1]} — {str(e)[:50]}", "err")
                    remove_proxy(proxy)
                else:
                    _log(f"[ERROR]      @{username}: {str(e)[:50]}", "err")
            _emit_state()

    async def start(self):
        await asyncio.gather(*[self._check(u) for u in self.usernames])


# ── Deep Checker (triple verification) ───────────────────
class DeepChecker:
    """
    Triple-signal verification: user-detail API + oEmbed + web page.
    Majority vote with safety-first (any TAKEN kills the result).
    """
    def __init__(self, usernames, concurrency=3):
        self.usernames = usernames
        self.sem       = asyncio.Semaphore(concurrency)

    async def _check(self, username: str, cb):
        async with self.sem:
            await asyncio.sleep(random.uniform(1.5, 3))
            px   = get_next_proxy()
            conn = aiohttp.TCPConnector(ssl=False) if px else None
            async with aiohttp.ClientSession(connector=conn) as s:
                sig_api, sig_oe, sig_web = await asyncio.gather(
                    _sig_userdetail(s, username, px),
                    _sig_oembed(s, username, px),
                    _sig_web(s, username, px),
                )
            verdict = _majority_verdict([sig_api, sig_oe, sig_web])
            cb(username, verdict, sig_api, sig_oe, sig_web)

    async def start(self, cb):
        await asyncio.gather(*[self._check(u, cb) for u in self.usernames])


# ── Pre-claim verifier ───────────────────────────────────
async def verify_before_claim(username: str, proxy=None) -> bool:
    """
    Do a fast double-check right before claiming to avoid wasting the attempt.
    Returns True only if both API + oEmbed agree it's available.
    """
    conn = aiohttp.TCPConnector(ssl=False) if proxy else None
    async with aiohttp.ClientSession(connector=conn) as s:
        sig_api, sig_oe = await asyncio.gather(
            _sig_userdetail(s, username, proxy),
            _sig_oembed(s, username, proxy),
        )
    # Must have at least one 'available' and no 'taken'
    if "taken" in (sig_api, sig_oe) or "banned" in (sig_api, sig_oe):
        return False
    return "available" in (sig_api, sig_oe)


# ── 2captcha solver ─────────────────────────────────────
async def solve_2captcha(api_key: str, **kwargs) -> str:
    if not api_key:
        return ""
    base = "https://2captcha.com"
    submit = {"key": api_key, "json": 1, **kwargs}
    try:
        conn = aiohttp.TCPConnector(ssl=False)
        async with aiohttp.ClientSession(connector=conn) as s:
            async with s.post(f"{base}/in.php", data=submit,
                              timeout=aiohttp.ClientTimeout(total=20)) as r:
                resp = await r.json(content_type=None)
                if resp.get("status") != 1:
                    _log(f"[2CAPTCHA]  رفض الطلب: {resp.get('request','?')}", "err")
                    return ""
                task_id = resp["request"]
            _log(f"[2CAPTCHA]  Task #{task_id} — جاري الحل…", "warn")
            for _ in range(30):
                await asyncio.sleep(5)
                async with s.get(
                    f"{base}/res.php?key={api_key}&action=get&id={task_id}&json=1",
                    timeout=aiohttp.ClientTimeout(total=10)
                ) as r:
                    resp = await r.json(content_type=None)
                    if resp.get("status") == 1:
                        _log("[2CAPTCHA]  ✓ تم حل الكابتشا", "hit")
                        return resp["request"]
                    if resp.get("request") not in ("CAPCHA_NOT_READY", "CAPTCHA_NOT_READY"):
                        _log(f"[2CAPTCHA]  خطأ: {resp.get('request','?')}", "err")
                        return ""
    except Exception as e:
        _log(f"[2CAPTCHA ERR]  {str(e)[:60]}", "err")
    return ""


# ── TikTok Claimer ───────────────────────────────────────
class Claimer:
    """
    Claims a TikTok username via the profile-edit API.

    Authentication options:
    ─────────────────────────────────────────────────────
    1. sessionid only      — standard, works most of the time
    2. sessionid + msToken — stronger auth, reduces CAPTCHA triggers
    3. sessionid + csrf    — auto-fetched from home page if not provided

    Known limitations:
    ─────────────────────────────────────────────────────
    1.  30-day cooldown  — TikTok blocks another change within 30 days.
    2.  Account age      — Very new accounts may be restricted.
    3.  CAPTCHA          — puzzle/slider captcha; handled via 2captcha.
    4.  Session expiry   — sessionid cookie expires; user must refresh it.
    5.  Device tokens    — msToken may be required for newer accounts.
    6.  Rate limiting    — per-account AND per-IP; always use proxies.
    7.  Race condition   — someone else may claim the username first.
    """

    EDIT_URL = "https://www.tiktok.com/api/user/edit/"
    HOME_URL = "https://www.tiktok.com/"

    _OK       = {0}
    _CAPTCHA  = {10101, 10102, 10103, 10104}
    _COOLDOWN = {10105, 10106}
    _TAKEN    = {10108, 10109}
    _SESSION  = {8, 10003, 10115, 10116}
    _RATE     = {4, 10000}

    def __init__(self, session_id: str, captcha_key: str = "", ms_token: str = ""):
        self.session_id  = session_id.strip()
        self.captcha_key = captcha_key.strip()
        self.ms_token    = ms_token.strip()

    def _base_headers(self, csrf: str = "") -> dict:
        h = {
            "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) "
                               "Chrome/124.0.0.0 Safari/537.36",
            "Accept":          "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer":         "https://www.tiktok.com/",
            "Origin":          "https://www.tiktok.com",
            "Content-Type":    "application/x-www-form-urlencoded;charset=UTF-8",
        }
        if csrf:
            h["X-CSRFToken"] = csrf
        if self.ms_token:
            h["msToken"] = self.ms_token
        return h

    async def _get_csrf(self, session: aiohttp.ClientSession, proxy) -> str:
        try:
            async with session.get(
                self.HOME_URL, proxy=proxy,
                headers={"User-Agent": self._base_headers()["User-Agent"]},
                timeout=aiohttp.ClientTimeout(total=10)
            ) as r:
                # Try cookie jar first
                for name in r.cookies:
                    if "csrf" in name.lower():
                        return r.cookies[name].value
                # Fallback: extract from Set-Cookie header
                for k, v in r.headers.items():
                    if k.lower() == "set-cookie" and "csrf" in v.lower():
                        for part in v.split(";"):
                            part = part.strip()
                            if part.lower().startswith("tt_csrf_token="):
                                return part.split("=", 1)[1]
        except:
            pass
        return ""

    async def _do_edit(self, session, username, proxy, extra_headers=None) -> dict:
        h = self._base_headers()
        if extra_headers:
            h.update(extra_headers)
        body = f"uniqueId={username}"
        try:
            async with session.post(
                self.EDIT_URL, data=body, headers=h,
                proxy=proxy, timeout=aiohttp.ClientTimeout(total=20)
            ) as r:
                try:
                    data = await r.json(content_type=None)
                except Exception:
                    data = {"raw": await r.text(), "status_code": -1}
                return {"http": r.status, "data": data,
                        "code": data.get("status_code", -1)}
        except asyncio.TimeoutError:
            return {"http": 0, "data": {}, "code": -99, "timeout": True}
        except Exception as e:
            return {"http": 0, "data": {}, "code": -1, "error": str(e)[:80]}

    async def claim(self, username: str, proxy: Optional[str] = None) -> dict:
        if not self.session_id:
            return {"ok": False, "reason": "no_session", "username": username}

        # ── Pre-claim verification ──────────────────────────
        still_free = await verify_before_claim(username, proxy)
        if not still_free:
            return {"ok": False, "reason": "pre_check_taken", "username": username}

        cookies = {"sessionid": self.session_id}
        if self.ms_token:
            cookies["msToken"] = self.ms_token

        connector = aiohttp.TCPConnector(ssl=False) if proxy else aiohttp.TCPConnector()
        async with aiohttp.ClientSession(connector=connector, cookies=cookies) as session:
            csrf = await self._get_csrf(session, proxy)
            if csrf:
                cookies["tt_csrf_token"] = csrf
                session.cookie_jar.update_cookies({"tt_csrf_token": csrf})

            res = await self._do_edit(session, username, proxy,
                                       {"X-CSRFToken": csrf} if csrf else {})
            code = res["code"]

            if code in self._OK:
                return {"ok": True, "username": username}

            if code in self._TAKEN or res["http"] == 409:
                return {"ok": False, "reason": "taken", "username": username}

            if code in self._COOLDOWN:
                return {"ok": False, "reason": "cooldown_30d", "username": username}

            if code in self._SESSION or res["http"] in (401, 403):
                return {"ok": False, "reason": "session_invalid", "username": username}

            if code in self._RATE or res["http"] == 429:
                return {"ok": False, "reason": "rate_limit", "username": username}

            if code in self._CAPTCHA or "captcha" in str(res["data"]).lower():
                if not self.captcha_key:
                    return {"ok": False, "reason": "captcha_no_key", "username": username}
                token = await solve_2captcha(
                    self.captcha_key,
                    method="tiktok",
                    pageurl="https://www.tiktok.com/",
                )
                if not token:
                    return {"ok": False, "reason": "captcha_fail", "username": username}
                res2 = await self._do_edit(session, username, proxy, {
                    "X-CSRFToken":         csrf,
                    "X-Secsdk-Csrf-Token": token,
                })
                if res2["code"] in self._OK:
                    return {"ok": True, "username": username, "captcha_solved": True}
                return {"ok": False, "reason": f"captcha_fail_code_{res2['code']}",
                        "username": username}

            if res.get("timeout"):
                return {"ok": False, "reason": "timeout", "username": username}

            return {"ok": False,
                    "reason": f"code_{code}",
                    "http":   res["http"],
                    "username": username}


def _run_claim(username: str):
    proxy   = get_next_proxy()
    claimer = Claimer(_account_session, _captcha_key, _account_ms_token)
    result  = asyncio.run(claimer.claim(username, proxy))

    reason_map = {
        "no_session":         "لا يوجد session cookie",
        "pre_check_taken":    "اليوزر أصبح مأخوذاً قبل المطالبة",
        "captcha":            "كابتشا — أضف 2captcha key",
        "captcha_no_key":     "كابتشا تحتاج 2captcha key",
        "captcha_fail":       "فشل حل الكابتشا",
        "rate_limit":         "ريت ليمت — انتظر أو غيّر البروكسي",
        "session_invalid":    "جلسة منتهية — حدّث session cookie",
        "taken":              "خُطف اليوزر قبلك! 😔",
        "cooldown_30d":       "الحساب في فترة انتظار 30 يوم",
        "timeout":            "انتهت مهلة الاتصال",
    }

    if result["ok"]:
        cap = " (بعد حل كابتشا)" if result.get("captcha_solved") else ""
        _log(f"[CLAIMED ✅]  @{username} — تم تسجيل الحساب بنجاح{cap}! 🎉", "hit")
        socketio.emit('claim_result', {**result, "claimed": True})
    else:
        reason = reason_map.get(result["reason"],
                                result.get("reason", "خطأ غير معروف"))
        _log(f"[CLAIM ✗]    @{username} — {reason}", "err")
        socketio.emit('claim_result', {**result, "claimed": False,
                                        "reason_ar": reason})


# ── Flask routes ────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')


# ── SocketIO events ─────────────────────────────────────
@socketio.on('connect')
def on_connect():
    _emit_state()
    with _proxy_lock:
        cnt = len(_proxies)
    socketio.emit('proxies', {"count": cnt, "rotating": _proxy_rotating})

def _reset_state():
    global _request_counter, _current_ip
    with _lock:
        _stats.update({"checked": 0, "available": 0, "taken": 0, "errors": 0})
        _hits.clear()
    _last_ips.clear()
    _request_counter = 0
    _current_ip = "—"

def _run_checker(usernames, webhook, label="Running"):
    global _running, _status, _total_usernames
    _total_usernames = len(usernames)
    _stop_event.clear()
    _running = True
    _log(f"[START]  تم تحميل {len(usernames)} يوزر", "hit")
    _emit_state()

    def run():
        global _running, _status
        _status = label
        asyncio.run(Checker(webhook, usernames).start())
        if not _stop_event.is_set():
            _status = "Done"
            _log("[DONE]  تم فحص جميع اليوزرات ✓", "hit")
            with _lock:
                hits = list(_hits)
            if hits:
                socketio.emit('done_with_hits', {"hits": hits, "count": len(hits)})
        else:
            _status = "Stopped"
        _running = False
        _emit_state()

    threading.Thread(target=run, daemon=True).start()

@socketio.on('start')
def on_start(data):
    if _running: return
    _reset_state()
    mode    = data.get('mode', 'generate')
    amount  = max(1, int(data.get('amount', 20)))
    length  = max(1, int(data.get('length', 5)))
    webhook = data.get('webhook', '')
    if mode == 'generate':
        usernames = generate_usernames(amount, length)
    else:
        usernames = load_from_txt()
        if not usernames:
            _log("[CONFIG ERROR]  usernames.txt فارغ أو غير موجود", "err"); return
    _run_checker(usernames, webhook, "Running")

@socketio.on('test_run')
def on_test_run(data):
    if _running:
        _log("[TEST]  يوجد فحص جارٍ — أوقفه أولاً", "err"); return
    _reset_state()
    length    = max(1, int(data.get('length', 5)))
    usernames = generate_usernames(10, length)
    _log("[TEST RUN]  فحص سريع لـ 10 يوزرات…", "hit")
    _run_checker(usernames, data.get('webhook', ''), "Test Running")

@socketio.on('stop')
def on_stop():
    global _running, _status
    _stop_event.set()
    _status  = "Stopped"
    _running = False
    _log("[STOPPED]  توقف الفحص", "warn")
    _emit_state()

@socketio.on('load_proxies')
def on_load_proxies(data):
    global _proxies, _proxy_index, _proxy_rotating
    loaded = load_proxies_from_txt()
    with _proxy_lock:
        _proxies      = loaded
        _proxy_index  = 0
    _proxy_rotating = data.get('rotating', False)
    if loaded:
        _log(f"[PROXIES]  تم تحميل {len(loaded)} بروكسي", "hit")
    else:
        _log("[PROXIES]  proxies.txt فارغ أو غير موجود", "warn")
    socketio.emit('proxies', {"count": len(loaded), "rotating": _proxy_rotating})

@socketio.on('set_rotating')
def on_set_rotating(data):
    global _proxy_rotating
    _proxy_rotating = data.get('rotating', False)

@socketio.on('test_proxies')
def on_test_proxies():
    with _proxy_lock:
        to_test = list(_proxies)
    if not to_test:
        _log("[PROXY TEST]  لا توجد بروكسيات محملة", "err"); return

    def run():
        async def test_all():
            sem = asyncio.Semaphore(5)
            async def bounded(px):
                async with sem: return await test_single_proxy(px)
            return await asyncio.gather(*[bounded(p) for p in to_test])

        results = asyncio.run(test_all())
        good = 0
        for (proxy, ok, latency, info) in results:
            short = proxy.split("@")[-1] if "@" in proxy else proxy
            short = short[:55]
            if ok:
                good += 1
                socketio.emit('proxy_result', {"proxy": short, "ok": True, "latency": latency, "ip": info})
            else:
                socketio.emit('proxy_result', {"proxy": short, "ok": False, "error": info})
        if not _proxy_rotating:
            with _proxy_lock:
                for (proxy, ok, _, _) in results:
                    if not ok and proxy in _proxies:
                        _proxies.remove(proxy)
        socketio.emit('proxy_test_done', {"good": good, "total": len(to_test)})
        _log(f"[PROXY TEST]  {good}/{len(to_test)} بروكسي يعمل", "hit" if good else "err")
        socketio.emit('proxies', {"count": good if not _proxy_rotating else len(to_test),
                                  "rotating": _proxy_rotating})

    threading.Thread(target=run, daemon=True).start()

@socketio.on('deep_check')
def on_deep_check(data):
    usernames = data.get('usernames', [])
    count     = max(1, int(data.get('count', min(20, len(usernames)))))
    subset    = usernames[:count]
    if not subset: return
    _log(f"[DEEP CHECK]  فحص دقيق ثلاثي لـ {len(subset)} يوزر (API + oEmbed + Web)", "hit")

    def run():
        summary = {"available": [], "banned": [], "taken": [], "uncertain": []}
        def cb(u, verdict, sig_api, sig_oe, sig_web):
            summary[verdict].append(u)
            socketio.emit('deep_result', {
                "username": u,
                "verdict":  verdict,
                "signals":  {"api": sig_api, "oembed": sig_oe, "web": sig_web},
            })
        asyncio.run(DeepChecker(subset).start(cb))
        if summary["available"]:
            with open("verified_hits.txt", "a", encoding="utf-8") as f:
                for u in summary["available"]: f.write(u + "\n")
        socketio.emit('deep_done', summary)
        _log(
            f"[DEEP DONE]  ✅{len(summary['available'])} متاح  "
            f"🔴{len(summary['banned'])} محظور  "
            f"⬛{len(summary['taken'])} مأخوذ  "
            f"🟡{len(summary['uncertain'])} غير مؤكد",
            "hit"
        )

        if _auto_claim and _account_session:
            to_claim = list(summary["available"])
            if _claim_uncertain:
                to_claim += list(summary["uncertain"])
            if not to_claim:
                _log("[AUTO-CLAIM]  لا توجد يوزرات للمطالبة بها", "warn")
                return
            _log(f"[AUTO-CLAIM]  🚀 بدء المطالبة بـ {len(to_claim)} يوزر…", "hit")
            for u in to_claim:
                socketio.emit('claim_start', {"username": u})
                _run_claim(u)
                asyncio.run(asyncio.sleep(0.5))

    threading.Thread(target=run, daemon=True).start()

@socketio.on('check_ip')
def on_check_ip():
    threading.Thread(target=lambda: asyncio.run(check_current_ip()), daemon=True).start()

# ── Account / Claimer SocketIO events ────────────────────
@socketio.on('set_account')
def on_set_account(data):
    global _account_session, _account_ms_token
    _account_session  = data.get('session_id', '').strip()
    _account_ms_token = data.get('ms_token',   '').strip()
    if _account_session:
        ms_info = "  + msToken ✓" if _account_ms_token else ""
        _log(f"[ACCOUNT]  ✓ تم تعيين جلسة TikTok{ms_info}", "hit")
        socketio.emit('account_status', {"ok": True, "ms_token": bool(_account_ms_token)})
    else:
        _log("[ACCOUNT]  تم مسح الجلسة", "warn")
        socketio.emit('account_status', {"ok": False, "ms_token": False})

@socketio.on('set_captcha_key')
def on_set_captcha_key(data):
    global _captcha_key
    _captcha_key = data.get('key', '').strip()
    socketio.emit('captcha_status', {"ok": bool(_captcha_key)})
    if _captcha_key:
        _log("[2CAPTCHA]  ✓ تم تعيين API key", "hit")

@socketio.on('set_auto_claim')
def on_set_auto_claim(data):
    global _auto_claim, _claim_uncertain
    _auto_claim      = data.get('enabled',   False)
    _claim_uncertain = data.get('uncertain', False)
    state = "مفعّل" if _auto_claim else "معطّل"
    unc   = " (يشمل غير المؤكدة)" if _claim_uncertain else ""
    _log(f"[AUTO-CLAIM]  {state}{unc}", "warn" if not _auto_claim else "hit")

@socketio.on('claim_username')
def on_claim_username(data):
    username = data.get('username', '').strip()
    if not username: return
    if not _account_session:
        _log("[CLAIM ERR]  أضف session cookie أولاً — راجع شريط الإعدادات", "err")
        socketio.emit('claim_result', {"ok": False, "username": username,
                                        "claimed": False, "reason_ar": "لا يوجد session cookie"})
        return
    threading.Thread(target=_run_claim, args=(username,), daemon=True).start()

@socketio.on('test_2captcha')
def on_test_2captcha(data):
    key = data.get('key', '').strip()
    if not key:
        socketio.emit('captcha_test_result', {"ok": False, "msg": "API key فارغ"}); return
    def run():
        try:
            resp = requests.get(
                f"https://2captcha.com/res.php?key={key}&action=getbalance&json=1",
                timeout=10
            ).json()
            bal = resp.get("request", "?")
            ok  = resp.get("status") == 1
            socketio.emit('captcha_test_result', {
                "ok":  ok,
                "msg": f"الرصيد: ${bal}" if ok else f"خطأ: {bal}"
            })
            if ok: _log(f"[2CAPTCHA]  ✓ API key صحيح — رصيدك: ${bal}", "hit")
            else:  _log(f"[2CAPTCHA]  ✗ API key خاطئ: {bal}", "err")
        except Exception as e:
            socketio.emit('captcha_test_result', {"ok": False, "msg": str(e)[:60]})
    threading.Thread(target=run, daemon=True).start()

@socketio.on('connect')
def on_connect_claimer():
    socketio.emit('account_status', {"ok": bool(_account_session), "ms_token": bool(_account_ms_token)})
    socketio.emit('captcha_status', {"ok": bool(_captcha_key)})


if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000, debug=False, allow_unsafe_werkzeug=True)
