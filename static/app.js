// ── Socket.IO connection ──────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

// ── State ─────────────────────────────────────────────
let isRunning   = false;
let totalNames  = 0;
let checkedCnt  = 0;
let deepHits    = [];
let proxyCount  = 0;

// ── Clock ─────────────────────────────────────────────
setInterval(() => {
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  document.getElementById('clock').textContent =
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}, 1000);

// ── Socket events ─────────────────────────────────────
socket.on('log', ({ msg, kind }) => appendLog(msg, kind));

socket.on('stats', s => {
  animateNum('s-checked', s.checked);
  animateNum('s-avail',   s.available);
  animateNum('s-taken',   s.taken);
  animateNum('s-errors',  s.errors);
  checkedCnt = s.checked;
});

socket.on('hits', hits => renderHits(hits));

socket.on('status', s => {
  isRunning  = s.running;
  totalNames = s.total;
  checkedCnt = s.checked;
  updatePill(s.running, s.status);
  updateStatusBar(s.running, s.status);
  updateProgress(s.checked, s.total);
});

socket.on('ip', ({ ip, changed }) => {
  document.getElementById('current-ip').textContent = ip;
  const box = document.getElementById('ip-box');
  box.style.borderColor = changed ? 'rgba(0,255,179,0.6)' : 'rgba(0,229,255,0.15)';
  setTimeout(() => { box.style.borderColor = 'rgba(0,229,255,0.15)'; }, 2000);
});

socket.on('proxies', ({ count, rotating }) => {
  proxyCount = count;
  const b = document.getElementById('proxy-badge');
  b.textContent = count > 0 ? `${count} loaded` : '0 loaded';
  b.className   = 'proxy-badge' + (count > 0 ? ' loaded' : '');
  document.getElementById('rotating-check').checked = rotating;
});

socket.on('done_with_hits', ({ hits, count }) => {
  deepHits = hits;
  openDeepModal(hits);
});

// Proxy test results
socket.on('proxy_result', ({ proxy, ok, latency, ip, error }) => {
  const body = document.getElementById('proxy-body');
  const line = document.createElement('div');
  if (ok) {
    line.className = 'proxy-ok';
    line.textContent = `✅  ${proxy.padEnd(50)}  ${latency}ms  [${ip}]`;
  } else {
    line.className = 'proxy-fail';
    line.textContent = `❌  ${proxy.padEnd(50)}  ${error}`;
  }
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
});
socket.on('proxy_test_done', ({ good, total }) => {
  const sep = document.createElement('div');
  sep.className = 'proxy-hdr';
  sep.textContent = `${'─'.repeat(60)}`;
  const sum = document.createElement('div');
  sum.className = 'proxy-hdr';
  sum.textContent = `النتيجة: ${good} يعمل  •  ${total - good} فاشل  —  من أصل ${total}`;
  document.getElementById('proxy-body').append(sep, sum);
  document.getElementById('proxy-prog').textContent = `اكتمل ✓  —  ${good}/${total} بروكسي شغّال`;
});

// Deep check results
socket.on('deep_result', ({ username, verdict, signals }) => {
  const body   = document.getElementById('deep-body');
  const icons  = { available:'✅', banned:'🔴', taken:'⬛', uncertain:'🟡' };
  const cls    = { available:'deep-avail', banned:'deep-banned', taken:'deep-taken', uncertain:'deep-uncertain' };
  const line   = document.createElement('div');
  line.className  = cls[verdict] || '';
  // Show per-signal breakdown
  let sigStr = '';
  if (signals) {
    const s = signals;
    const dot = v => v === 'available' ? '✅' : v === 'taken' ? '⬛' : v === 'banned' ? '🔴' : '🟡';
    sigStr = `  [API:${dot(s.api)} oEmbed:${dot(s.oembed)} Web:${dot(s.web)}]`;
  }
  line.textContent = `  ${icons[verdict] || '?'}  @${username}  →  ${verdict}${sigStr}`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
  const prog = document.getElementById('deep-prog');
  const cur  = parseInt(prog.dataset.cur || 0) + 1;
  prog.dataset.cur = cur;
  const max = parseInt(document.getElementById('deep-count').value) || 20;
  prog.textContent = `جاري الفحص… ${cur} / ${max}`;
});
socket.on('deep_done', summary => {
  const body = document.getElementById('deep-body');
  ['','─'.repeat(54)].forEach(t => {
    const d = document.createElement('div');
    d.className = 'deep-summary'; d.textContent = t;
    body.appendChild(d);
  });
  const rows = [
    `  ✅ متاح فعلاً     : ${summary.available.length}`,
    `  🔴 محظور/معطّل   : ${summary.banned.length}`,
    `  ⬛ مأخوذ          : ${summary.taken.length}`,
    `  🟡 غير مؤكد       : ${summary.uncertain.length}`,
  ];
  if (summary.available.length)
    rows.push(`\n  ✓ تم الحفظ في verified_hits.txt`);
  rows.forEach(t => {
    const d = document.createElement('div');
    d.className = 'deep-summary'; d.textContent = t;
    body.appendChild(d);
  });
  body.scrollTop = body.scrollHeight;
  document.getElementById('deep-prog').textContent =
    `اكتمل ✓  —  ${summary.available.length} يوزر مؤكد متاح`;
});

// ── UI helpers ─────────────────────────────────────────
function appendLog(msg, kind) {
  const wrap = document.getElementById('log-wrap');
  const span = document.createElement('span');
  span.className = 'log-line';
  // split timestamp from rest
  const ts   = msg.slice(0, 11);
  const rest = msg.slice(11);
  const tsEl = document.createElement('span');
  tsEl.className   = 'log-ts';
  tsEl.textContent = ts;
  const bodyEl = document.createElement('span');
  bodyEl.className   = `log-${kind}`;
  bodyEl.textContent = rest + '\n';
  span.append(tsEl, bodyEl);
  wrap.appendChild(span);
  // keep last 300 lines
  while (wrap.children.length > 300) wrap.removeChild(wrap.firstChild);
  wrap.scrollTop = wrap.scrollHeight;
}

function clearLog() {
  document.getElementById('log-wrap').innerHTML = '';
}

function renderHits(hits) {
  const wrap = document.getElementById('hits-wrap');
  wrap.innerHTML = '';
  hits.slice().reverse().forEach((u, i) => {
    const num = hits.length - i;
    const div = document.createElement('div');
    div.className = 'hit-item';
    div.innerHTML =
      `<span class="hit-num">${String(num).padStart(3,' ')}.  </span>` +
      `<span class="hit-name">@${u}</span>` +
      `<button id="claim-${u}" class="claim-btn claim-btn-ready" onclick="claimUsername('${u}')">⚡ CLAIM</button><br>` +
      `<span class="hit-link">     tiktok.com/@${u}</span>`;
    wrap.appendChild(div);
  });
}

function updatePill(running, status) {
  const pill = document.getElementById('pill');
  if (running) {
    pill.className = 'pill running';
    pill.innerHTML = '<span class="pill-dot pulse">◐</span> RUNNING';
  } else {
    pill.className = 'pill';
    pill.innerHTML = '<span class="pill-dot">◉</span> ' + (status || 'IDLE').toUpperCase();
  }
}

function updateStatusBar(running, status) {
  const el = document.getElementById('status-txt');
  el.textContent = running ? `◈  ${status}` : `⚡  ${status || 'Idle'}`;
  el.style.color = running ? 'var(--green)' : 'var(--subtext)';
}

function updateProgress(checked, total) {
  const pct = total > 0 ? Math.min(100, (checked / total) * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  const shimmer = document.getElementById('progress-shimmer');
  if (isRunning && pct > 0) shimmer.classList.add('active');
  else shimmer.classList.remove('active');
}

// Animated number counter
const _animTargets = {};
function animateNum(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  const current = parseInt(el.textContent) || 0;
  if (current === target) return;
  if (_animTargets[id]) clearInterval(_animTargets[id]);
  const diff  = target - current;
  const steps = Math.min(Math.abs(diff), 12);
  let   step  = 0;
  _animTargets[id] = setInterval(() => {
    step++;
    const val = Math.round(current + diff * (step / steps));
    el.textContent = val;
    if (step >= steps) {
      el.textContent = target;
      clearInterval(_animTargets[id]);
    }
  }, 25);
}

// ── Control functions ─────────────────────────────────
function getCfg() {
  return {
    mode:    document.querySelector('input[name="mode"]:checked').value,
    amount:  parseInt(document.getElementById('cfg-amount').value) || 20,
    length:  parseInt(document.getElementById('cfg-length').value) || 5,
    webhook: document.getElementById('cfg-webhook').value,
  };
}

function startCheck() {
  if (isRunning) return;
  socket.emit('start', getCfg());
}
function stopCheck() {
  socket.emit('stop');
}
function testRun() {
  if (isRunning) return;
  socket.emit('test_run', getCfg());
}
function loadProxies() {
  const rotating = document.getElementById('rotating-check').checked;
  socket.emit('load_proxies', { rotating });
}
function toggleRotating() {
  const rotating = document.getElementById('rotating-check').checked;
  socket.emit('set_rotating', { rotating });
}

// ── Deep Check modal ──────────────────────────────────
function openDeepModal(hits) {
  deepHits = hits;
  document.getElementById('deep-info').textContent =
    `تم العثور على ${hits.length} يوزر محتمل.\n` +
    `الفحص الدقيق يستخدم 3 مصادر: User-Detail API + oEmbed + صفحة الويب\n` +
    `يحتاج أغلبية الإشارات قبل الحكم بالإتاحة — لا أخطاء.\n` +
    `النتائج: ✅ متاح  •  🔴 محظور/معطّل  •  ⬛ مأخوذ  •  🟡 غير مؤكد`;
  document.getElementById('deep-count').value = Math.min(20, hits.length);
  document.getElementById('deep-max').textContent = `(max ${hits.length})`;
  document.getElementById('deep-body').innerHTML = '';
  document.getElementById('deep-prog').textContent = '';
  document.getElementById('deep-prog').dataset.cur = '0';
  document.getElementById('deep-overlay').style.display = 'flex';
}
function closeDeepModal(e) {
  if (e && e.target !== document.getElementById('deep-overlay')) return;
  document.getElementById('deep-overlay').style.display = 'none';
}
function startDeepCheck() {
  const count = parseInt(document.getElementById('deep-count').value) || 20;
  document.getElementById('deep-body').innerHTML = '';
  document.getElementById('deep-prog').dataset.cur = '0';
  socket.emit('deep_check', { usernames: deepHits, count });
}

// ── Proxy Test modal ──────────────────────────────────
function openProxyModal() {
  if (proxyCount === 0) {
    appendLog(`[PROXY TEST]  اضغط Load proxies.txt أولاً`, 'err');
    return;
  }
  document.getElementById('proxy-body').innerHTML = '';
  document.getElementById('proxy-prog').textContent = '';
  document.getElementById('proxy-overlay').style.display = 'flex';
}
function closeProxyModal(e) {
  if (e && e.target !== document.getElementById('proxy-overlay')) return;
  document.getElementById('proxy-overlay').style.display = 'none';
}
function runProxyTest() {
  document.getElementById('proxy-body').innerHTML = '';
  document.getElementById('proxy-prog').textContent = 'جاري الفحص…';
  socket.emit('test_proxies');
}

// ── Claimer events ────────────────────────────────────
socket.on('account_status', ({ ok }) => {
  const dot = document.getElementById('acct-dot');
  if (dot) { dot.className = 'status-dot ' + (ok ? 'ok' : 'err'); dot.title = ok ? '✓ جلسة مضبوطة' : '✗ لا توجد جلسة'; }
});
socket.on('captcha_status', ({ ok }) => {
  const dot = document.getElementById('cap-dot');
  if (dot) { dot.className = 'status-dot ' + (ok ? 'ok' : 'err'); dot.title = ok ? '✓ API key مضبوط' : '✗ لا يوجد key'; }
});
socket.on('captcha_test_result', ({ ok, msg }) => {
  const el = document.getElementById('cap-bal');
  if (el) { el.textContent = msg; el.style.color = ok ? 'var(--green)' : 'var(--red)'; }
});
socket.on('claim_start', ({ username }) => {
  const btn = document.getElementById(`claim-${username}`);
  if (btn) { btn.className = 'claim-btn claim-btn-loading'; btn.textContent = '⟳ جاري…'; btn.disabled = true; }
});
socket.on('claim_result', ({ username, claimed, reason_ar }) => {
  const btn = document.getElementById(`claim-${username}`);
  if (!btn) return;
  if (claimed) {
    btn.className   = 'claim-btn claim-btn-ok';
    btn.textContent = '✅ تم!';
  } else {
    btn.className   = 'claim-btn claim-btn-fail';
    btn.textContent = '✗ ' + (reason_ar || 'فشل').slice(0, 20);
    btn.title       = reason_ar || '';
  }
  btn.disabled = false;
});

// ── Claimer controls ───────────────────────────────────
let _acctDirty = false, _capDirty = false;
function accountDirty() { _acctDirty = true; }
function captchaDirty() { _capDirty  = true; }

function setAccount() {
  const val = document.getElementById('cfg-session').value.trim();
  const ms  = document.getElementById('cfg-mstoken').value.trim();
  socket.emit('set_account', { session_id: val, ms_token: ms });
  _acctDirty = false;
}
function setCaptchaKey() {
  const val = document.getElementById('cfg-captcha').value.trim();
  socket.emit('set_captcha_key', { key: val });
  _capDirty = false;
}
function toggleAutoClaim() {
  socket.emit('set_auto_claim', {
    enabled:   document.getElementById('auto-claim-chk').checked,
    uncertain: document.getElementById('uncertain-chk').checked,
  });
}
function test2captcha() {
  const key = document.getElementById('cfg-captcha').value.trim();
  if (!key) { alert('أدخل API key أولاً'); return; }
  setCaptchaKey();
  document.getElementById('cap-bal').textContent = 'جاري الفحص…';
  socket.emit('test_2captcha', { key });
}
function claimUsername(username) {
  if (_acctDirty) setAccount();
  socket.emit('claim_username', { username });
}
function toggleHint(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ── Particle system ───────────────────────────────────
const canvas = document.getElementById('particles');
const ctx    = canvas.getContext('2d');
let W, H, particles = [];

function resize() {
  W = canvas.width  = window.innerWidth;
  H = canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

class Particle {
  constructor(born = true) {
    this.x    = Math.random() * W;
    this.y    = born ? H + 5 : Math.random() * H;
    this.vy   = -(0.3 + Math.random() * 0.9);
    this.vx   = (Math.random() - 0.5) * 0.3;
    this.r    = 1 + Math.random() * 1.5;
    this.life = 1.0;
    this.dec  = 0.003 + Math.random() * 0.005;
    this.hue  = Math.random() < 0.5 ? 'cyan' : 'teal';
  }
  step() {
    this.x    += this.vx;
    this.y    += this.vy;
    this.life -= this.dec;
  }
  get color() {
    const a = this.life * 0.8;
    return this.hue === 'cyan'
      ? `rgba(0,229,255,${a})`
      : `rgba(0,255,179,${a})`;
  }
}

for (let i = 0; i < 55; i++) particles.push(new Particle(false));

function drawParticles() {
  ctx.clearRect(0, 0, W, H);
  for (const p of particles) {
    p.step();
    if (p.life <= 0 || p.y < -10) {
      Object.assign(p, new Particle(true));
    }
    const r = p.r * p.life;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
  }
  requestAnimationFrame(drawParticles);
}
drawParticles();
