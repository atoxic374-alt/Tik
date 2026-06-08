// ── Socket.IO ──────────────────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

// ── State ──────────────────────────────────────────────
let isRunning  = false;
let totalNames = 0;
let checkedCnt = 0;
let deepHits   = [];
let proxyCount = 0;

// ── Clock ──────────────────────────────────────────────
setInterval(() => {
  const n = new Date(), p = v => String(v).padStart(2,'0');
  const el = document.getElementById('clock');
  if (el) el.textContent = `${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
}, 1000);

// ══════════════════════════════════════════════════════
//  SOCKET EVENTS
// ══════════════════════════════════════════════════════
socket.on('log', ({ msg, kind }) => appendLog(msg, kind));

socket.on('stats', s => {
  animateNum('s-checked', s.checked);
  animateNum('s-avail',   s.available);
  animateNum('s-taken',   s.taken);
  animateNum('s-errors',  s.errors);
  checkedCnt = s.checked;
});

socket.on('hits', hits => {
  renderHits(hits);
  const cnt = document.getElementById('hits-count');
  if (cnt) cnt.textContent = hits.length > 0 ? `${hits.length}` : '';
});

socket.on('status', s => {
  isRunning  = s.running;
  totalNames = s.total;
  checkedCnt = s.checked;
  updatePill(s.running, s.status);
  updateStatusBar(s.running, s.status);
  updateProgress(s.checked, s.total);
});

socket.on('ip', ({ ip, changed }) => {
  const el  = document.getElementById('current-ip');
  const box = document.getElementById('ip-box');
  if (el)  el.textContent = ip;
  if (box) {
    if (changed) {
      box.classList.add('changed');
      setTimeout(() => box.classList.remove('changed'), 2500);
    }
  }
});

socket.on('proxies', ({ count, rotating }) => {
  proxyCount = count;
  const b = document.getElementById('proxy-badge');
  if (b) {
    b.textContent = count > 0 ? `${count} loaded` : '0 loaded';
    b.className   = 'proxy-badge' + (count > 0 ? ' loaded' : '');
  }
  const rc = document.getElementById('rotating-check');
  if (rc) rc.checked = rotating;
});

socket.on('done_with_hits', ({ hits }) => {
  deepHits = hits;
  openDeepModal(hits);
});

// Proxy test
socket.on('proxy_result', ({ proxy, ok, latency, ip, error }) => {
  const body = document.getElementById('proxy-body');
  const line = document.createElement('div');
  line.className   = ok ? 'proxy-ok' : 'proxy-fail';
  line.textContent = ok
    ? `✓  ${proxy.padEnd(48)}  ${latency}ms  [${ip}]`
    : `✗  ${proxy.padEnd(48)}  ${error}`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
});
socket.on('proxy_test_done', ({ good, total }) => {
  const sep = document.createElement('div');
  sep.className   = 'proxy-hdr';
  sep.textContent = '─'.repeat(50);
  const sum = document.createElement('div');
  sum.className   = 'proxy-hdr';
  sum.textContent = `النتيجة: ${good} يعمل · ${total - good} فاشل — من أصل ${total}`;
  document.getElementById('proxy-body').append(sep, sum);
  document.getElementById('proxy-prog').textContent = `اكتمل ✓ — ${good}/${total} بروكسي شغّال`;
});

// Deep check
socket.on('deep_result', ({ username, verdict, signals }) => {
  const body  = document.getElementById('deep-body');
  const icons = { available:'✅', banned:'🔴', taken:'⬛', uncertain:'🟡' };
  const cls   = { available:'deep-avail', banned:'deep-banned', taken:'deep-taken', uncertain:'deep-uncertain' };
  const line  = document.createElement('div');
  line.className = cls[verdict] || '';
  let sigStr = '';
  if (signals) {
    const d = v => v==='available'?'✅':v==='taken'?'⬛':v==='banned'?'🔴':'🟡';
    sigStr = `  [API:${d(signals.api)} oEmbed:${d(signals.oembed)} Web:${d(signals.web)}]`;
  }
  line.textContent = `${icons[verdict]||'?'}  @${username}  →  ${verdict}${sigStr}`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
  const prog = document.getElementById('deep-prog');
  const cur  = parseInt(prog.dataset.cur || 0) + 1;
  prog.dataset.cur = cur;
  const max = parseInt(document.getElementById('deep-count').value) || 20;
  prog.textContent = `جاري الفحص…  ${cur} / ${max}`;
});
socket.on('deep_done', summary => {
  const body = document.getElementById('deep-body');
  ['', '─'.repeat(52)].forEach(t => {
    const d = document.createElement('div');
    d.className = 'deep-summary'; d.textContent = t;
    body.appendChild(d);
  });
  [
    `✅ متاح فعلاً     : ${summary.available.length}`,
    `🔴 محظور/معطّل   : ${summary.banned.length}`,
    `⬛ مأخوذ          : ${summary.taken.length}`,
    `🟡 غير مؤكد       : ${summary.uncertain.length}`,
    ...(summary.available.length ? [`\n✓ تم الحفظ في verified_hits.txt`] : []),
  ].forEach(t => {
    const d = document.createElement('div');
    d.className = 'deep-summary'; d.textContent = t;
    body.appendChild(d);
  });
  body.scrollTop = body.scrollHeight;
  document.getElementById('deep-prog').textContent =
    `اكتمل ✓ — ${summary.available.length} يوزر مؤكد متاح`;
});

// Claimer
socket.on('account_status', ({ ok }) => {
  const dot = document.getElementById('acct-dot');
  if (dot) dot.className = 'status-dot ' + (ok ? 'ok' : 'err');
});
socket.on('captcha_status', ({ ok }) => {
  const dot = document.getElementById('cap-dot');
  if (dot) dot.className = 'status-dot ' + (ok ? 'ok' : 'err');
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
  btn.className   = claimed ? 'claim-btn claim-btn-ok' : 'claim-btn claim-btn-fail';
  btn.textContent = claimed ? '✓ تم!' : '✗ ' + (reason_ar || 'فشل').slice(0, 22);
  btn.title       = reason_ar || '';
  btn.disabled    = false;
});

// ══════════════════════════════════════════════════════
//  UI HELPERS
// ══════════════════════════════════════════════════════
function appendLog(msg, kind) {
  const wrap = document.getElementById('log-wrap');
  const span = document.createElement('span');
  span.className = 'log-line';
  const ts     = msg.slice(0, 11);
  const rest   = msg.slice(11);
  const tsEl   = document.createElement('span');
  tsEl.className   = 'log-ts';
  tsEl.textContent = ts;
  const bodyEl = document.createElement('span');
  bodyEl.className   = `log-${kind}`;
  bodyEl.textContent = rest + '\n';
  span.append(tsEl, bodyEl);
  wrap.appendChild(span);
  while (wrap.children.length > 400) wrap.removeChild(wrap.firstChild);
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
      `<span class="hit-name">@${u}</span><br>` +
      `<button id="claim-${u}" class="claim-btn claim-btn-ready" onclick="claimUsername('${u}')">⚡ CLAIM</button>` +
      `<span class="hit-link">  tiktok.com/@${u}</span>`;
    wrap.appendChild(div);
  });
}

function updatePill(running, status) {
  const pill = document.getElementById('pill');
  const dot  = document.getElementById('pill-dot');
  const txt  = document.getElementById('pill-txt');
  if (!pill) return;
  pill.className = running ? 'pill running' : 'pill';
  if (txt) txt.textContent = running ? 'RUNNING' : (status || 'IDLE').toUpperCase();
}

function updateStatusBar(running, status) {
  const el = document.getElementById('status-txt');
  if (!el) return;
  el.innerHTML = running
    ? `<svg width="9" height="9" viewBox="0 0 9 9" fill="none" style="margin-right:5px;vertical-align:middle"><circle cx="4.5" cy="4.5" r="3.5" fill="var(--green)" opacity="0.7"/></svg>${status}`
    : `<svg width="9" height="9" viewBox="0 0 9 9" fill="none" style="margin-right:5px;vertical-align:middle"><circle cx="4.5" cy="4.5" r="3.5" fill="var(--subtext)" opacity="0.5"/></svg>${status || 'Idle'}`;
}

function updateProgress(checked, total) {
  const pct = total > 0 ? Math.min(100, (checked / total) * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  const shimmer = document.getElementById('progress-shimmer');
  if (isRunning && pct > 0) shimmer.classList.add('active');
  else shimmer.classList.remove('active');
}

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
    el.textContent = Math.round(current + diff * (step / steps));
    if (step >= steps) { el.textContent = target; clearInterval(_animTargets[id]); }
  }, 25);
}

// ══════════════════════════════════════════════════════
//  CONTROL FUNCTIONS
// ══════════════════════════════════════════════════════
function getCfg() {
  return {
    mode:    document.querySelector('input[name="mode"]:checked').value,
    amount:  parseInt(document.getElementById('cfg-amount').value)  || 20,
    length:  document.getElementById('cfg-length').value.trim()     || '5',
    prefix:  document.getElementById('cfg-prefix').value.trim()     || '',
    webhook: document.getElementById('cfg-webhook').value.trim()    || '',
  };
}
function startCheck() { if (!isRunning) socket.emit('start', getCfg()); }
function stopCheck()  { socket.emit('stop'); }
function testRun()    { if (!isRunning) socket.emit('test_run', getCfg()); }
function loadProxies()    { socket.emit('load_proxies', { rotating: document.getElementById('rotating-check').checked }); }
function toggleRotating() { socket.emit('set_rotating', { rotating: document.getElementById('rotating-check').checked }); }

// ══════════════════════════════════════════════════════
//  DEEP CHECK MODAL
// ══════════════════════════════════════════════════════
function openDeepModal(hits) {
  deepHits = hits;
  document.getElementById('deep-info').textContent =
    `تم العثور على ${hits.length} يوزر محتمل.\n` +
    `الفحص الدقيق يستخدم 3 مصادر: User-Detail API + oEmbed + صفحة الويب\n` +
    `يحتاج أغلبية الإشارات قبل الحكم — لا نتائج كاذبة.`;
  document.getElementById('deep-count').value        = Math.min(20, hits.length);
  document.getElementById('deep-max').textContent    = `(max ${hits.length})`;
  document.getElementById('deep-body').innerHTML     = '';
  document.getElementById('deep-prog').textContent   = '';
  document.getElementById('deep-prog').dataset.cur   = '0';
  document.getElementById('deep-overlay').style.display = 'flex';
}
function closeDeepModal(e) {
  if (e && e.target !== document.getElementById('deep-overlay')) return;
  document.getElementById('deep-overlay').style.display = 'none';
}
function startDeepCheck() {
  const count = parseInt(document.getElementById('deep-count').value) || 20;
  document.getElementById('deep-body').innerHTML   = '';
  document.getElementById('deep-prog').dataset.cur = '0';
  socket.emit('deep_check', { usernames: deepHits, count });
}

// ══════════════════════════════════════════════════════
//  PROXY TEST MODAL
// ══════════════════════════════════════════════════════
function openProxyModal() {
  if (proxyCount === 0) { appendLog('[PROXY TEST]  اضغط Load proxies.txt أولاً', 'err'); return; }
  document.getElementById('proxy-body').innerHTML   = '';
  document.getElementById('proxy-prog').textContent = '';
  document.getElementById('proxy-overlay').style.display = 'flex';
}
function closeProxyModal(e) {
  if (e && e.target !== document.getElementById('proxy-overlay')) return;
  document.getElementById('proxy-overlay').style.display = 'none';
}
function runProxyTest() {
  document.getElementById('proxy-body').innerHTML   = '';
  document.getElementById('proxy-prog').textContent = 'جاري الفحص…';
  socket.emit('test_proxies');
}

// ══════════════════════════════════════════════════════
//  CLAIMER CONTROLS
// ══════════════════════════════════════════════════════
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
  if (!key) return;
  setCaptchaKey();
  const bal = document.getElementById('cap-bal');
  if (bal) bal.textContent = 'جاري الفحص…';
  socket.emit('test_2captcha', { key });
}
function claimUsername(username) {
  if (_acctDirty) setAccount();
  socket.emit('claim_username', { username });
}

// ══════════════════════════════════════════════════════
//  HELP MODAL
// ══════════════════════════════════════════════════════
const HELP_CONTENT = {
  lengths: {
    title: 'LENGTHS — طول اليوزرات',
    html: `
      <h3>كيف تستخدم حقل الطول</h3>
      <p>يمكنك تحديد الطول بثلاث طرق:</p>
      <div class="ex-row"><span class="ex-key">5</span><span class="ex-val">طول ثابت — كل اليوزرات بـ 5 أحرف</span></div>
      <div class="ex-row"><span class="ex-key">3-6</span><span class="ex-val">نطاق — يوزرات بأطوال 3 و4 و5 و6 بالتناوب</span></div>
      <div class="ex-row"><span class="ex-key">3,5,7</span><span class="ex-val">قائمة — فقط الأطوال المحددة بالتناوب</span></div>
      <div class="tip">
        <span class="tip-icon">💡</span>
        <p>الأطوال القصيرة (3-4 أحرف) أندر وأكثر قيمة، لكن يصعب إيجادها. جرّب <code>3-5</code> لتوازن جيد.</p>
      </div>
    `
  },
  prefix: {
    title: 'PREFIX — بادئة اليوزر',
    html: `
      <h3>ما هو الـ PREFIX؟</h3>
      <p>هو نص يُضاف في بداية كل يوزر مُنتَج تلقائياً.</p>
      <div class="ex-row"><span class="ex-key">a</span><span class="ex-val">يوزرات مثل: <code>axk3</code>, <code>apqz</code>, <code>a9fn</code></span></div>
      <div class="ex-row"><span class="ex-key">sw</span><span class="ex-val">يوزرات مثل: <code>swxk3</code>, <code>swpqz</code></span></div>
      <div class="ex-row"><span class="ex-key">_x</span><span class="ex-val">يوزرات مثل: <code>_xkf3</code>, <code>_xmpq</code></span></div>
      <h3>ملاحظة مهمة</h3>
      <p>الطول المحدد في حقل LENGTHS هو طول الجزء العشوائي فقط، والبادئة تُضاف فوقه. مثلاً: prefix=<code>a</code> + length=<code>4</code> → يوزر من 5 أحرف إجمالاً.</p>
      <div class="tip">
        <span class="tip-icon">💡</span>
        <p>ابحث عن بادئات ذات معنى مثل اسمك أو اهتمامك، تزيد من قيمة اليوزر.</p>
      </div>
    `
  },
  webhook: {
    title: 'DISCORD WEBHOOK',
    html: `
      <h3>كيف تحصل على Webhook URL</h3>
      <ol>
        <li>افتح سيرفر Discord الخاص بك</li>
        <li>اضغط على الإعدادات ← Integrations ← Webhooks</li>
        <li>اضغط New Webhook وامنحه اسماً</li>
        <li>اضغط Copy Webhook URL</li>
        <li>الصقه في الحقل</li>
      </ol>
      <h3>ما الذي يُرسَل؟</h3>
      <p>عند اكتشاف يوزر متاح، تُرسل رسالة فورية تحتوي على: <code>Available: @username</code></p>
      <div class="tip">
        <span class="tip-icon">💡</span>
        <p>اترك الحقل فارغاً إذا لم تكن تريد إشعارات Discord.</p>
      </div>
    `
  },
  account: {
    title: 'ACCOUNT — بيانات الحساب',
    html: `
      <h3>SESSION ID (مطلوب)</h3>
      <ol>
        <li>افتح <code>www.tiktok.com</code> وسجّل دخولك</li>
        <li>اضغط <code>F12</code> لفتح DevTools</li>
        <li>اذهب إلى: Application → Cookies → www.tiktok.com</li>
        <li>ابحث عن <code>sessionid</code> وانسخ قيمته</li>
        <li>الصقه في حقل SESSION ID</li>
      </ol>
      <h3>MS TOKEN (اختياري)</h3>
      <ol>
        <li>في نفس قائمة الكوكيز</li>
        <li>ابحث عن <code>msToken</code> وانسخ قيمته</li>
        <li>يقلّل بشكل كبير أخطاء CAPTCHA و"جرب اسماً آخر"</li>
      </ol>
      <div class="tip">
        <span class="tip-icon">⚠️</span>
        <p>إذا انتهت صلاحية الجلسة، أعد تسجيل الدخول لـ TikTok وحدّث الكوكيز مجدداً.</p>
      </div>
    `
  },
  captcha: {
    title: '2CAPTCHA — حل الكابتشا',
    html: `
      <h3>كيف تحصل على API Key</h3>
      <ol>
        <li>افتح <code>2captcha.com</code> وأنشئ حساباً</li>
        <li>اشحن رصيدك (يبدأ من $3)</li>
        <li>اذهب إلى Dashboard ← API Key</li>
        <li>انسخ المفتاح والصقه في الحقل</li>
        <li>اضغط Apply ثم Balance للتحقق</li>
      </ol>
      <h3>متى يُستخدم؟</h3>
      <p>عندما يطلب TikTok حل CAPTCHA أثناء عملية الـ claim، يتم إرسالها لـ 2captcha تلقائياً وحلها.</p>
      <div class="tip">
        <span class="tip-icon">💡</span>
        <p>اختياري إذا كنت تستخدم proxies جيدة وحساباً قديماً. ضروري للحسابات الجديدة.</p>
      </div>
    `
  },
};

function showHelp(type) {
  const content = HELP_CONTENT[type];
  if (!content) return;
  document.getElementById('help-title').innerHTML =
    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none">
       <circle cx="8" cy="8" r="6.5" stroke="var(--purple)" stroke-width="1.3"/>
       <text x="8" y="12" text-anchor="middle" fill="var(--purple)" font-size="9" font-weight="700" font-family="Inter">?</text>
     </svg>${content.title}`;
  document.getElementById('help-body').innerHTML = content.html;
  document.getElementById('help-overlay').style.display = 'flex';
}
function closeHelp(e) {
  if (e && e.target !== document.getElementById('help-overlay')) return;
  document.getElementById('help-overlay').style.display = 'none';
}

// ══════════════════════════════════════════════════════
//  PARTICLES
// ══════════════════════════════════════════════════════
const canvas = document.getElementById('particles');
const ctx    = canvas.getContext('2d');
let W, H;

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
    this.vy   = -(0.25 + Math.random() * 0.7);
    this.vx   = (Math.random() - 0.5) * 0.25;
    this.r    = 0.8 + Math.random() * 1.4;
    this.life = 1.0;
    this.dec  = 0.003 + Math.random() * 0.004;
    this.hue  = Math.random() < 0.5 ? 0 : 1;
  }
  step() { this.x += this.vx; this.y += this.vy; this.life -= this.dec; }
  get color() {
    const a = this.life * 0.7;
    return this.hue === 0 ? `rgba(0,229,255,${a})` : `rgba(0,255,179,${a})`;
  }
}

const particles = [];
for (let i = 0; i < 50; i++) particles.push(new Particle(false));

function drawParticles() {
  ctx.clearRect(0, 0, W, H);
  for (const p of particles) {
    p.step();
    if (p.life <= 0 || p.y < -10) Object.assign(p, new Particle(true));
    const r = p.r * p.life;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
  }
  requestAnimationFrame(drawParticles);
}
drawParticles();
