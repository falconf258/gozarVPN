'use strict';

const state = {
  schema: [],
  profiles: {},
  activeProfile: 'default',
  currentSettings: {},
  connectStartedAt: null,
  uptimeTimer: null,
  engine: 'aether'
};

const GROUP_TARGET = {
  connection: 'form-connection',
  protocol: 'form-protocol',
  masque: 'form-masque',
  wireguard: 'form-wireguard',
  zerotrust: 'form-zerotrust',
  routing: 'form-routing',
  advanced: 'form-advanced'
};

const STATUS_LABEL = {
  stopped: 'قطع',
  starting: 'در حال شروع…',
  scanning: 'در حال اسکن گیت‌وی…',
  'gateway-selected': 'در حال برقراری تونل…',
  connected: 'متصل',
  reconnecting: 'اتصال مجدد…',
  error: 'خطا'
};

const PRESETS = [
  { label: 'Turbo', desc: 'سریع‌ترین اسکن', scan: 'turbo', noize: 'off' },
  { label: 'Balanced', desc: 'پیش‌فرض متعادل', scan: 'balanced', noize: 'balanced' },
  { label: 'Thorough', desc: 'اسکن دقیق‌تر', scan: 'thorough', noize: 'balanced' },
  { label: 'Stealth', desc: 'مخفی‌کاری بالا', scan: 'stealth', noize: 'aggressive' },
  { label: 'Ironclad', desc: 'بررسی واقعی HTTP هر کاندید', scan: 'ironclad', noize: 'aggressive' }
];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// ---------- In-app dialogs ----------
// Native await uiAlert()/confirm() freeze text inputs in Electron on Windows (the
// window keeps rendering but stops accepting focus/typing until it is
// blurred and refocused), and prompt() isn't implemented at all. These
// promise-based modals replace all three.
function uiDialog({ message, okText = 'باشه', cancelText = null, input = null, danger = false }) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const overlay = el('div', { class: 'modal-overlay' });
    const msg = el('div', { class: 'modal-msg' }, String(message));
    const field = input !== null ? el('input', { type: input.type || 'text', class: 'modal-input', value: input.value || '', placeholder: input.placeholder || '' }) : null;
    const okBtn = el('button', { class: `btn ${danger ? 'danger-solid' : 'primary'}` }, okText);
    const cancelBtn = cancelText ? el('button', { class: 'btn ghost' }, cancelText) : null;
    const box = el('div', { class: 'modal-box', role: 'dialog' }, [msg, field, el('div', { class: 'modal-actions' }, [okBtn, cancelBtn])]);
    overlay.appendChild(box);

    const done = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(cancelText ? (field ? null : false) : true); }
      else if (e.key === 'Enter') { e.preventDefault(); done(field ? field.value : true); }
    };
    okBtn.addEventListener('click', () => done(field ? field.value : true));
    if (cancelBtn) cancelBtn.addEventListener('click', () => done(field ? null : false));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    (field || okBtn).focus();
  });
}
const uiAlert = (message) => uiDialog({ message });
const uiConfirm = (message, opts = {}) => uiDialog({ message, okText: opts.okText || 'تأیید', cancelText: 'انصراف', danger: !!opts.danger });
const uiPrompt = (message, placeholder = '') => uiDialog({ message, okText: 'ثبت', cancelText: 'انصراف', input: { placeholder } });


function fieldValue(field) {
  const v = state.currentSettings[field.key];
  if (v !== undefined) return v;
  return field.default !== undefined ? field.default : '';
}

function setSetting(key, value) {
  state.currentSettings[key] = value;
  if (key === 'AETHER_SCAN' || key === 'AETHER_NOIZE') renderPresets();
  scheduleAutosave();
}

let autosaveHandle = null;
function scheduleAutosave() {
  clearTimeout(autosaveHandle);
  autosaveHandle = setTimeout(async () => {
    await window.aether.saveProfile(state.activeProfile, state.currentSettings);
    refreshDashboardMeta();
  }, 400);
}

function renderField(field) {
  const wrap = el('div', { class: field.type === 'checkbox' || field.type === 'bool' ? 'field checkbox' : 'field' });
  const value = fieldValue(field);

  if (field.type === 'bool') {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!value;
    input.addEventListener('change', () => setSetting(field.key, input.checked));
    wrap.appendChild(input);
    wrap.appendChild(el('label', {}, field.label));
    return wrap;
  }

  wrap.appendChild(el('label', {}, field.label));

  if (field.type === 'select') {
    const select = el('select');
    for (const opt of field.options) {
      const optEl = el('option', { value: opt }, opt === '' ? '(پیش‌فرض)' : opt);
      if (opt === value) optEl.selected = true;
      select.appendChild(optEl);
    }
    select.addEventListener('change', () => setSetting(field.key, select.value));
    wrap.appendChild(select);
    return wrap;
  }

  if (field.type === 'textarea') {
    const ta = el('textarea', { placeholder: field.placeholder || '' });
    ta.value = value || '';
    ta.addEventListener('change', () => setSetting(field.key, ta.value));
    wrap.appendChild(ta);
    return wrap;
  }

  if (field.type === 'file') {
    const inner = el('div', { class: 'field-file' });
    const input = el('input', { type: 'text', placeholder: field.placeholder || 'مسیر فایل' });
    input.value = value || '';
    input.addEventListener('change', () => setSetting(field.key, input.value));
    inner.appendChild(input);
    wrap.appendChild(inner);
    return wrap;
  }

  const inputType = field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text';
  const input = el('input', { type: inputType, placeholder: field.placeholder || '' });
  input.value = value || '';
  input.addEventListener('change', () => setSetting(field.key, field.type === 'number' ? Number(input.value) : input.value));
  wrap.appendChild(input);
  return wrap;
}

function renderForms() {
  for (const target of Object.values(GROUP_TARGET)) {
    document.getElementById(target).innerHTML = '';
  }
  for (const field of state.schema) {
    const targetId = GROUP_TARGET[field.group];
    if (!targetId) continue;
    document.getElementById(targetId).appendChild(renderField(field));
  }
}

function renderPresets() {
  const container = document.getElementById('quick-presets');
  container.innerHTML = '';
  const curScan = state.currentSettings.AETHER_SCAN || 'balanced';
  const curNoize = state.currentSettings.AETHER_NOIZE || 'balanced';
  for (const p of PRESETS) {
    const isSelected = curScan === p.scan && curNoize === p.noize;
    const btn = el('button', {
      class: `preset-btn${isSelected ? ' selected' : ''}`,
      type: 'button',
      onclick: () => {
        setSetting('AETHER_SCAN', p.scan);
        setSetting('AETHER_NOIZE', p.noize);
        renderForms();
        renderPresets();
        refreshDashboardMeta();
      }
    }, [el('b', {}, p.label), el('small', {}, p.desc)]);
    container.appendChild(btn);
  }
}

function refreshDashboardMeta() {
  const heroEngine = document.getElementById('hero-engine');
  if (heroEngine) {
    const cfg = state.activeV2rayConfigObj;
    const prof = state.activeMihomoProfileObj;
    heroEngine.textContent = state.engine === 'singbox'
      ? (cfg ? cfg.name : 'V2ray / Xray')
      : state.engine === 'tor'
      ? `Tor · ${state.torMode || 'auto'}`
      : state.engine === 'psiphon'
      ? (state.psiphonRoute === 'only' ? 'فقط سایفون' : 'سایفون از طریق Aether')
      : state.engine === 'openvpn'
      ? (state.openvpnName ? `OpenVPN · ${state.openvpnName}` : 'OpenVPN')
      : state.engine === 'mihomo'
        ? (state.mihomoNow ? `${prof ? prof.name : 'Clash'} › ${state.mihomoNow}` : (prof ? prof.name : 'Clash / mihomo'))
        : `Aether · ${state.currentSettings.AETHER_PROTOCOL || 'masque'}`;
  }
  if (state.engine === 'tor') {
    document.getElementById('dash-protocol').textContent = 'Tor';
    document.getElementById('dash-scan').textContent = state.torMode || 'auto';
    document.getElementById('dash-noize').textContent = 'bridges';
    return;
  }
  if (state.engine === 'mihomo') {
    const prof = state.activeMihomoProfileObj;
    document.getElementById('dash-protocol').textContent = prof ? prof.name : 'پروفایلی انتخاب نشده';
    document.getElementById('dash-scan').textContent = state.mihomoNow || '-';
    document.getElementById('dash-noize').textContent = 'mihomo';
    return;
  }
  if (state.engine === 'singbox') {
    const cfg = state.activeV2rayConfigObj;
    document.getElementById('dash-protocol').textContent = cfg ? cfg.protocol : 'کانفیگی انتخاب نشده';
    document.getElementById('dash-scan').textContent = cfg ? cfg.name : '-';
    document.getElementById('dash-noize').textContent = 'sing-box';

    const box = document.getElementById('dash-v2ray-active');
    box.innerHTML = '';
    if (cfg) {
      box.appendChild(el('div', {}, [el('span', { class: 'badge' }, cfg.protocol), ' ', el('b', {}, cfg.name)]));
    } else {
      box.appendChild(el('p', { class: 'muted' }, 'هیچ کانفیگی فعال نیست.'));
    }
    return;
  }
  document.getElementById('dash-protocol').textContent = state.currentSettings.AETHER_PROTOCOL || 'masque';
  document.getElementById('dash-scan').textContent = state.currentSettings.AETHER_SCAN || 'balanced';
  document.getElementById('dash-noize').textContent = state.currentSettings.AETHER_NOIZE || 'balanced';
}

async function populateProfiles() {
  const data = await window.aether.getProfiles();
  state.profiles = data.profiles;
  state.activeProfile = data.active;
  state.currentSettings = { ...(data.profiles[data.active] || {}) };

  const select = document.getElementById('profile-select');
  select.innerHTML = '';
  for (const name of Object.keys(state.profiles)) {
    select.appendChild(el('option', { value: name }, name));
  }
  select.value = state.activeProfile;

  document.getElementById('ui-launch-startup').checked = !!data.ui.launchOnStartup;
  document.getElementById('ui-start-minimized').checked = !!data.ui.startMinimized;
  document.getElementById('ui-close-action').value = data.ui.closeAction || (data.ui.closeToTray === false ? 'quit' : 'ask');
  document.getElementById('ui-auto-proxy').checked = data.ui.autoSystemProxy !== false;
  document.getElementById('ui-socks-only-proxy').checked = !!data.ui.socksOnlySystemProxy;
  state.tunMode = !!data.ui.tunMode;
  renderModeSwitch();
}

// ---------- Connection mode: system proxy vs. real TUN ----------
function renderModeSwitch() {
  document.querySelectorAll('#mode-switch .engine-option').forEach((btn) => {
    btn.classList.toggle('active', (btn.dataset.mode === 'tun') === !!state.tunMode);
    btn.disabled = !!lastKnownState.running;
  });
  const cb = document.getElementById('ui-tun-mode');
  if (cb) cb.checked = !!state.tunMode;
  const lbl = document.getElementById('dash-mode');
  if (lbl) lbl.textContent = state.tunMode ? 'TUN (کل سیستم)' : 'پراکسی سیستم';
}

async function setTunMode(enabled) {
  if (lastKnownState.running) {
    await uiAlert('برای تغییر حالت اتصال، ابتدا قطع اتصال کنید.');
    renderModeSwitch();
    return;
  }
  if (enabled && !(await window.aether.isElevated())) {
    const ok = await uiConfirm('حالت TUN یک کارت شبکه‌ی مجازی می‌سازد و به دسترسی Administrator نیاز دارد.\n\nبرنامه با دسترسی مدیر دوباره اجرا شود؟');
    if (!ok) { renderModeSwitch(); return; }
    state.tunMode = true;
    await window.aether.setUiPrefs({ tunMode: true });
    await window.aether.relaunchAsAdmin();
    return;
  }
  state.tunMode = !!enabled;
  await window.aether.setUiPrefs({ tunMode: state.tunMode });
  renderModeSwitch();
}

function setTunBadge(tun) {
  const badge = document.getElementById('tun-badge');
  if (!badge) return;
  const text = {
    starting: 'TUN: در حال ساخت آداپتور…',
    up: 'TUN روشن است و همه‌ی ترافیک سیستم از تونل می‌رود',
    error: 'TUN بالا نیامد، به‌جایش پراکسی سیستم روشن شد (لاگ را ببینید)',
    'needs-admin': 'TUN دسترسی Administrator می‌خواهد، به‌جایش پراکسی سیستم روشن شد',
    'missing-singbox': 'TUN هسته‌ی sing-box لازم دارد. از تب کانفیگ‌ها دانلودش کنید'
  }[tun && tun.status];
  badge.style.display = text ? 'block' : 'none';
  badge.className = `tun-badge ${tun ? tun.status : ''}`;
  if (text) badge.textContent = text;
}

function wireTunMode() {
  document.getElementById('mode-switch').addEventListener('click', (e) => {
    const btn = e.target.closest('.engine-option');
    if (!btn || btn.disabled) return;
    setTunMode(btn.dataset.mode === 'tun');
  });
  document.getElementById('ui-tun-mode').addEventListener('change', (e) => setTunMode(e.target.checked));
  document.getElementById('relaunch-admin').addEventListener('click', () => window.aether.relaunchAsAdmin());
  window.aether.isElevated().then((elevated) => {
    const s = document.getElementById('admin-status');
    if (s) s.textContent = elevated ? 'برنامه با دسترسی Administrator اجرا شده است ✓' : 'برنامه بدون دسترسی Administrator اجرا شده است.';
    document.getElementById('relaunch-admin').style.display = elevated ? 'none' : '';
  });
  window.aether.onTunStatus(setTunBadge);
  // The big status ring doubles as the connect/disconnect button.
  document.getElementById('status-ring').addEventListener('click', () => {
    const connectBtn = document.getElementById('dash-connect-btn');
    const target = connectBtn.style.display === 'none' ? document.getElementById('dash-disconnect-btn') : connectBtn;
    if (!target.disabled) target.click();
  });
  window.aether.getTunState().then(setTunBadge);
}

function setTunnelBanner(data) {
  const banner = document.getElementById('tunnel-verify-banner');
  if (!data || data.status === 'idle') {
    banner.style.display = 'none';
    return;
  }
  banner.style.display = 'block';
  banner.className = `tunnel-banner ${data.status}`;
  if (data.status === 'checking') {
    banner.textContent = 'در حال بررسی اینکه تونل واقعاً ترافیک رد می‌کند…';
  } else if (data.status === 'ok') {
    banner.textContent = data.mode === 'tun'
      ? '✅ تونل سالم است. در حال روشن کردن TUN برای کل سیستم…'
      : '✅ تونل سالم است و پراکسی سیستم روشن شد.';
  } else if (data.status === 'failed') {
    banner.textContent = `❌ بررسی تونل ناموفق بود (${data.error || ''}). برای همین پراکسی سیستم روشن نشد و اینترنت شما دست‌نخورده ماند. جزئیات در تب لاگ است.`;
    // the check can be wrong (a filtered probe URL); let the user decide
    const go = el('button', { class: 'btn ghost small', style: 'margin-top:8px', type: 'button' }, 'ادامه به هر حال (فعال کردن پراکسی/TUN)');
    go.addEventListener('click', async () => {
      go.disabled = true;
      try { await window.aether.forceEnableTunnel(); } catch (err) { go.disabled = false; await uiAlert(shortError(err.message || err)); }
    });
    banner.appendChild(el('br'));
    banner.appendChild(go);
  }
}

let pendingConnectAction = null; // 'connecting' | 'disconnecting' | null
let pendingSince = 0;
let lastKnownState = { running: false, status: 'stopped' };

function setConnectButtonsState(stateData) {
  const running = !!stateData.running;
  const status = stateData.status || 'stopped';

  const transitionText = {
    starting: 'در حال شروع…',
    scanning: 'در حال اسکن…',
    'gateway-selected': 'در حال برقراری تونل…',
    reconnecting: 'در حال اتصال مجدد…'
  }[status];

  const pairs = [
    { connect: document.getElementById('connect-btn'), disconnect: document.getElementById('disconnect-btn'), label: document.getElementById('connect-transition-label') },
    { connect: document.getElementById('dash-connect-btn'), disconnect: document.getElementById('dash-disconnect-btn'), label: document.getElementById('dash-transition-label') }
  ];

  let label = null;
  if (pendingConnectAction === 'connecting' && !running) label = 'در حال اتصال…';
  else if (pendingConnectAction === 'disconnecting') label = 'در حال قطع اتصال…';
  else if (running && transitionText) label = transitionText;

  for (const p of pairs) {
    if (!p.connect || !p.disconnect) continue;
    p.connect.style.display = running ? 'none' : '';
    p.disconnect.style.display = running ? '' : 'none';
    p.connect.disabled = pendingConnectAction === 'connecting';
    p.disconnect.disabled = pendingConnectAction === 'disconnecting';
    if (p.label) {
      p.label.style.display = label ? '' : 'none';
      p.label.textContent = label || '';
    }
  }
}

function setStatusUi(stateData) {
  const status = stateData.status || 'stopped';
  // Any fresh status from the core means the button click we were waiting
  // on has been heard and acted on (whatever the outcome) — clear the
  // "in progress, don't double-click" lock so the buttons reflect reality
  // again instead of staying stuck on a stale "در حال..." label.
  pendingConnectAction = null;
  lastKnownState = stateData;

  if (status === 'starting' || status === 'stopped') setTunnelBanner({ status: 'idle' });
  const statusLabel = (state.engine === 'tor' && status === 'starting' && stateData.progress)
    ? `اتصال به Tor… ${stateData.progress}٪`
    : (STATUS_LABEL[status] || status);
  document.getElementById('status-text').textContent = statusLabel;
  document.getElementById('status-dot').className = `dot ${status}`;

  document.querySelector('.app').classList.toggle('is-connected', status === 'connected');
  const ring = document.getElementById('status-ring');
  ring.className = `status-ring ${status}`;
  document.getElementById('status-ring-text').textContent = statusLabel;

  document.getElementById('dash-addr').textContent = stateData.address || '-';
  document.getElementById('proxy-addr').textContent = stateData.address
    ? `SOCKS5: ${stateData.address}${stateData.httpAddress ? ` · HTTP: ${stateData.httpAddress}` : ''}`
    : '';

  setConnectButtonsState(stateData);
  renderModeSwitch();
  if (!stateData.running) setTunBadge(null);

  clearInterval(state.uptimeTimer);
  if (status === 'connected' && stateData.startedAt) {
    state.connectStartedAt = stateData.startedAt;
    state.uptimeTimer = setInterval(updateUptime, 1000);
    updateUptime();
  } else {
    document.getElementById('dash-uptime').textContent = '00:00:00';
  }
}

function updateUptime() {
  if (!state.connectStartedAt) return;
  const secs = Math.floor((Date.now() - state.connectStartedAt) / 1000);
  const h = String(Math.floor(secs / 3600)).padStart(2, '0');
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  document.getElementById('dash-uptime').textContent = `${h}:${m}:${s}`;
}

/** A log line without its leading timestamp, to spot repeats. */
function logKey(text) {
  return String(text).replace(/^\[[^\]]*\]\s*/, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z?\s*/, '');
}

function appendLogLine(entry) {
  appendLogLines([entry]);
}

function appendLogLines(entries) {
  if (!entries.length) return;
  const consoleEl = document.getElementById('log-console');
  const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 40;
  const fragment = document.createDocumentFragment();
  // the same message repeated (e.g. Psiphon logging once a second) collapses into one line with a count
  let last = consoleEl.lastElementChild;
  for (const entry of entries) {
    const key = logKey(entry.text);
    if (last && last.dataset.key === key) {
      last.dataset.count = String(Number(last.dataset.count || 1) + 1);
      last.textContent = `(×${last.dataset.count}) ${entry.text}`;
      continue;
    }
    last = el('div', { class: `log-line ${entry.level}`, 'data-key': key }, entry.text);
    fragment.appendChild(last);
  }
  consoleEl.appendChild(fragment);
  // Keep the *visible* log console light (DOM nodes are far more expensive
  // than the plain-object entries in the main process's own log buffer,
  // which can stay at its full 4000-line cap independently) — a busy
  // VLESS session logs a line per connection, so this fills up fast.
  while (consoleEl.childNodes.length > 1500) consoleEl.removeChild(consoleEl.firstChild);
  if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}

// Compact layout: a bottom bar of top-level groups, plus a chip row of
// sub-pages for groups that have several (Aether settings, "more"). Both
// bars use .nav-item[data-tab], so existing code that does
// `.nav-item[data-tab="update"]').click()` keeps working.
const lastSubTab = { aether: 'protocol', configs: 'v2ray', more: 'settings' };

function showTab(tab) {
  let section = document.getElementById(`tab-${tab}`);
  if (!section && lastSubTab[tab]) {
    tab = lastSubTab[tab];
    section = document.getElementById(`tab-${tab}`);
  }
  if (!section) return;
  const group = section.dataset.group || tab;
  if (lastSubTab[group]) lastSubTab[group] = tab;

  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === section));
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab || b.dataset.tab === group);
  });
  document.querySelectorAll('.subnav').forEach((n) => {
    n.style.display = n.dataset.group === group ? 'flex' : 'none';
  });
  const activeChip = document.querySelector(`.subnav .chip[data-tab="${tab}"]`);
  if (activeChip) activeChip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  section.scrollTop = 0;
}

// Tab rows wider than the window: the mouse wheel and dragging scroll them sideways.
document.querySelectorAll('.subnav').forEach((nav) => {
  nav.addEventListener('wheel', (e) => {
    if (nav.scrollWidth <= nav.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    nav.scrollLeft -= e.deltaY; // RTL row: wheel down moves toward the later (left-hand) tabs
    e.preventDefault();
  }, { passive: false });
  let startX = null, startLeft = 0, moved = false;
  nav.addEventListener('pointerdown', (e) => { startX = e.clientX; startLeft = nav.scrollLeft; moved = false; });
  nav.addEventListener('pointermove', (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    if (!moved && Math.abs(dx) < 5) return;
    moved = true; nav.classList.add('dragging');
    nav.scrollLeft = startLeft - dx;
  });
  const end = () => { startX = null; nav.classList.remove('dragging'); };
  nav.addEventListener('pointerup', end);
  nav.addEventListener('pointerleave', end);
  // a drag shouldn't also count as a click on the chip under the pointer
  nav.addEventListener('click', (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
});

function wireNav() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    showTab(btn.dataset.tab);
  });
}

function wireConnectButtons() {
  const doConnect = async () => {
    if (pendingConnectAction) return;
    pendingConnectAction = 'connecting';
    pendingSince = Date.now();
    setConnectButtonsState(lastKnownState);
    try {
      const hasCore = await window.aether.hasCore();
      if (!hasCore) {
        pendingConnectAction = null;
        setConnectButtonsState(lastKnownState);
        if (state.engine === 'singbox') {
          await uiAlert('هسته sing-box نصب نشده یا هیچ کانفیگی انتخاب نشده. از تب «V2ray / Xray» آن را تنظیم کنید.');
          document.querySelector('.nav-item[data-tab="v2ray"]').click();
        } else if (state.engine === 'mihomo' || state.engine === 'tor') {
          await uiAlert(state.engine === 'tor' ? 'Tor هنوز نصب نشده. از تب «کانفیگ‌ها › Tor» دانلودش کنید.' : 'هسته‌ی mihomo نصب نیست یا پروفایلی انتخاب نشده. از تب «کانفیگ‌ها › Clash» تنظیمش کنید.');
          document.querySelector(`.nav-item[data-tab="${state.engine}"]`).click();
        } else {
          await uiAlert('هسته Aether (aether.exe) هنوز نصب نشده. از تب «به‌روزرسانی» آن را دانلود یا انتخاب کنید.');
          document.querySelector('.nav-item[data-tab="update"]').click();
        }
        return;
      }
      await window.aether.startCore();
      // Deliberately NOT clearing pendingConnectAction here — it stays
      // locked until the next core:status event actually confirms what
      // happened, so the button can't be double-clicked into starting a
      // second process while the first one is still spinning up.
    } catch (err) {
      pendingConnectAction = null;
      setConnectButtonsState(lastKnownState);
      await uiAlert(`خطا در اتصال: ${err.message || err}`);
    }
  };

  const doDisconnect = async () => {
    if (pendingConnectAction) return;
    pendingConnectAction = 'disconnecting';
    pendingSince = Date.now();
    setConnectButtonsState(lastKnownState);
    try {
      await window.aether.stopCore();
    } catch (err) {
      pendingConnectAction = null;
      setConnectButtonsState(lastKnownState);
      await uiAlert(`خطا در قطع اتصال: ${err.message || err}`);
    }
  };

  document.getElementById('connect-btn').addEventListener('click', doConnect);
  document.getElementById('dash-connect-btn').addEventListener('click', doConnect);
  document.getElementById('disconnect-btn').addEventListener('click', doDisconnect);
  document.getElementById('dash-disconnect-btn').addEventListener('click', doDisconnect);

  // Safety valve: if a click somehow never gets a status echo back (e.g.
  // the main process hit an unexpected exception before emitting one),
  // don't leave the buttons locked forever — release after 10s so the
  // person can always try again instead of the button looking "dead".
  setInterval(() => {
    if (pendingConnectAction && Date.now() - pendingSince > 10000) {
      pendingConnectAction = null;
      setConnectButtonsState(lastKnownState);
    }
  }, 1000);
}

function wireProfiles() {
  document.getElementById('profile-select').addEventListener('change', async (e) => {
    await window.aether.setActiveProfile(e.target.value);
    await populateProfiles();
    renderForms();
    renderPresets();
    refreshDashboardMeta();
  });

  document.getElementById('profile-save').addEventListener('click', async () => {
    const name = await uiPrompt('نام پروفایل جدید را وارد کنید:', 'مثلاً Home');
    if (!name) return;
    await window.aether.saveProfile(name, state.currentSettings);
    await populateProfiles();
    renderForms();
    renderPresets();
  });

  document.getElementById('profile-delete').addEventListener('click', async () => {
    if (state.activeProfile === 'default') {
      await uiAlert('پروفایل پیش‌فرض قابل حذف نیست.');
      return;
    }
    if (!(await uiConfirm(`پروفایل «${state.activeProfile}» حذف شود؟`))) return;
    await window.aether.deleteProfile(state.activeProfile);
    await populateProfiles();
    renderForms();
    renderPresets();
    refreshDashboardMeta();
  });
}

function wireSettingsTab() {
  const map = {
    'ui-launch-startup': 'launchOnStartup',
    'ui-start-minimized': 'startMinimized',
    'ui-auto-proxy': 'autoSystemProxy',
    'ui-socks-only-proxy': 'socksOnlySystemProxy'
  };
  for (const [id, key] of Object.entries(map)) {
    document.getElementById(id).addEventListener('change', (e) => {
      window.aether.setUiPrefs({ [key]: e.target.checked });
    });
  }
  document.getElementById('ui-close-action').addEventListener('change', (e) => {
    window.aether.setUiPrefs({ closeAction: e.target.value });
  });
  wireKillSwitch();
}

// ---------- Kill switch (firewall rules while connected) ----------
function paintKillSwitch(ks) {
  if (!ks) return;
  const cb = document.getElementById('ui-kill-switch');
  if (cb) cb.checked = !!ks.enabled;
  const s = document.getElementById('ks-status');
  if (s) s.textContent = ks.leftover && !ks.armed ? '⚠ قوانین کیل‌سوییچ از اجرای قبلی مانده‌اند؛ اگر اینترنت ندارید «اضطراری: حذف قوانین» را بزنید.'
    : ks.armed ? 'وضعیت: فعال (قوانین فایروال اعمال شده‌اند)' : ks.enabled ? 'وضعیت: با اتصال بعدی فعال می‌شود' : 'وضعیت: خاموش';
  const banner = document.getElementById('ks-banner');
  if (banner) banner.style.display = (ks.armed || ks.leftover) && !ks.connected ? 'block' : 'none';
}
const refreshKillSwitch = () => window.aether.killSwitchState().then(paintKillSwitch).catch(() => {});

function wireKillSwitch() {
  document.getElementById('ui-kill-switch').addEventListener('change', async (e) => {
    if (e.target.checked && !(await uiConfirm('کیل‌سوییچ هنگام اتصال، فایروال ویندوز را روشن می‌کند و همه‌ی ترافیک بیرون از VPN را می‌بندد. به دسترسی Administrator نیاز دارد.\n\nاگر برنامه ناگهان بسته شد و اینترنت نداشتید، برنامه را دوباره باز کنید یا «اضطراری: حذف قوانین» را بزنید.\n\nروشن شود؟'))) {
      e.target.checked = false;
      return;
    }
    await window.aether.setUiPrefs({ killSwitch: e.target.checked });
    if (e.target.checked && !(await window.aether.isElevated())) await uiAlert('برای کار کردن کیل‌سوییچ، برنامه را با «اجرای مجدد با دسترسی مدیر» باز کنید.');
    refreshKillSwitch();
  });
  const emergency = async (ev) => {
    if (ev) ev.preventDefault();
    paintKillSwitch(await window.aether.killSwitchEmergency());
  };
  document.getElementById('ks-emergency').addEventListener('click', () => emergency());
  document.getElementById('ks-banner-off').addEventListener('click', emergency);
  window.aether.onKillSwitch(paintKillSwitch);
  refreshKillSwitch();
}

function wireLogsTab() {
  document.getElementById('logs-clear').addEventListener('click', async () => {
    await window.aether.clearCoreLogs();
    document.getElementById('log-console').innerHTML = '';
  });
  const flash = (btn, text) => { const old = btn.textContent; btn.textContent = text; setTimeout(() => { btn.textContent = old; }, 1600); };
  document.getElementById('logs-copy').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    await window.aether.copyLogs();
    flash(btn, '✓ کپی شد');
  });
  document.getElementById('logs-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (await window.aether.saveLogs()) flash(btn, '✓ ذخیره شد');
  });
}

async function wireUpdateTab() {
  document.getElementById('gui-version').textContent = await window.aether.getAppVersion();

  async function refreshCoreVersion() {
    const v = await window.aether.getInstalledCoreVersion();
    document.getElementById('core-version').textContent = v || 'نصب نشده / نامشخص';
  }
  await refreshCoreVersion();

  let lastCoreCheck = null;

  document.getElementById('core-check').addEventListener('click', async () => {
    const statusEl = document.getElementById('core-update-status');
    statusEl.textContent = 'در حال بررسی…';
    try {
      lastCoreCheck = await window.aether.checkCoreUpdate();
      document.getElementById('core-changelog').textContent = lastCoreCheck.changelog || '';
      if (lastCoreCheck.updateAvailable) {
        statusEl.textContent = `نسخه جدید موجود است: ${lastCoreCheck.latestTag}`;
        document.getElementById('core-update-btn').disabled = false;
      } else {
        statusEl.textContent = 'هسته شما به‌روز است.';
        document.getElementById('core-update-btn').disabled = true;
      }
    } catch (err) {
      statusEl.textContent = `خطا: ${shortError(err.message || err)}`;
    }
  });

  document.getElementById('core-update-btn').addEventListener('click', async () => {
    const progressWrap = document.getElementById('core-progress');
    const progressBar = document.getElementById('core-progress-bar');
    progressWrap.classList.add('active');
    document.getElementById('core-update-btn').disabled = true;
    try {
      await window.aether.updateCore();
      document.getElementById('core-update-status').textContent = 'هسته با موفقیت به‌روزرسانی شد.';
      await refreshCoreVersion();
    } catch (err) {
      document.getElementById('core-update-status').textContent = `خطا در به‌روزرسانی: ${shortError(err.message || err)}`;
    } finally {
      progressBar.style.width = '0%';
      progressWrap.classList.remove('active');
    }
  });

  document.getElementById('core-manual').addEventListener('click', async () => {
    const statusEl = document.getElementById('core-update-status');
    try {
      if (await window.aether.pickExeManually()) {
        statusEl.textContent = 'هسته‌ی انتخاب‌شده نصب شد.';
        await refreshCoreVersion();
      }
    } catch (err) {
      statusEl.textContent = `خطا: ${shortError(err.message || err)}`;
    }
  });

  window.aether.onCoreUpdateProgress((progress) => {
    const bar = document.getElementById('core-progress-bar');
    bar.style.width = `${Math.round((progress.pct || 0) * 100)}%`;
    const phaseLabel = { downloading: 'در حال دانلود', verifying: 'در حال بررسی امضا', extracting: 'در حال استخراج', done: 'انجام شد' }[progress.phase] || progress.phase;
    document.getElementById('core-update-status').textContent = phaseLabel;
  });

  document.getElementById('app-check').addEventListener('click', () => window.aether.checkAppUpdate());
  document.getElementById('app-download').addEventListener('click', () => window.aether.downloadAppUpdate());
  document.getElementById('app-install').addEventListener('click', () => window.aether.installAppUpdate());

  document.getElementById('app-releases').addEventListener('click', () => window.aether.openReleases());
  const autoCheck = document.getElementById('ui-auto-update-check');
  const beta = document.getElementById('ui-update-beta');
  window.aether.getProfiles().then(({ ui }) => { autoCheck.checked = ui.autoUpdateCheck !== false; beta.checked = !!ui.updateBeta; });
  autoCheck.addEventListener('change', () => window.aether.setUiPrefs({ autoUpdateCheck: autoCheck.checked }));
  beta.addEventListener('change', () => window.aether.setUiPrefs({ updateBeta: beta.checked }));
  let portable = false;
  window.aether.appUpdateInfo().then((i) => {
    portable = i.portable;
    if (portable) document.getElementById('app-install').textContent = 'نمایش فایل جدید';
  });

  window.aether.onAppUpdateStatus(async (data) => {
    const statusEl = document.getElementById('app-update-status');
    const notesEl = document.getElementById('app-update-notes');
    if (data.phase === 'available') {
      const i = data.info || {};
      const mb = i.size ? ` · ${(i.size / 1048576).toFixed(1)} MB` : '';
      notesEl.textContent = `${i.name || ''}${i.prerelease ? ' (آزمایشی)' : ''}${mb}\n\n${i.notes || ''}`.trim();
      notesEl.style.display = '';
      // a check on startup: ask once per version
      if (data.quiet) {
        const seen = (await window.aether.getProfiles()).ui.updateSeen;
        if (seen !== i.version) {
          await window.aether.setUiPrefs({ updateSeen: i.version });
          if (await uiConfirm(`نسخه‌ی جدید GozarVpn آماده است: ${i.version}\n\nالان دانلود شود؟ (بیشتر › به‌روزرسانی)`)) window.aether.downloadAppUpdate();
        }
      }
    }
    const progressWrap = document.getElementById('app-progress');
    const progressBar = document.getElementById('app-progress-bar');
    if (data.phase === 'checking') statusEl.textContent = 'در حال بررسی…';
    if (data.phase === 'available') {
      statusEl.textContent = `نسخه جدید موجود است: ${data.info && data.info.version}`;
      document.getElementById('app-download').disabled = false;
    }
    if (data.phase === 'up-to-date') statusEl.textContent = 'شما از آخرین نسخه استفاده می‌کنید.';
    if (data.phase === 'downloading') {
      progressWrap.classList.add('active');
      progressBar.style.width = `${Math.round(data.percent || 0)}%`;
      statusEl.textContent = 'در حال دانلود به‌روزرسانی…';
    }
    if (data.phase === 'downloaded') {
      progressWrap.classList.remove('active');
      statusEl.textContent = data.portable
        ? `فایل جدید کنار همین برنامه ذخیره شد (${data.info && data.info.file}). این برنامه را ببندید و فایل جدید را اجرا کنید.`
        : 'دانلود و بررسی هش انجام شد. «نصب و راه‌اندازی مجدد» را بزنید (یا با بستن برنامه خودکار نصب می‌شود).';
      document.getElementById('app-install').disabled = false;
    }
    if (data.phase === 'error') {
      // the GUI's own release feed isn't published yet, so GitHub answers 404 with a whole HTML page
      progressWrap.classList.remove('active');
      statusEl.textContent = `خطا: ${shortError(data.error)} . می‌توانید از «صفحه‌ی انتشارها» دستی دانلود کنید.`;
    }
  });
}

async function wireEngineSelector() {
  const buttons = Array.from(document.querySelectorAll('#engine-switch .engine-option'));

  function paint() {
    for (const btn of buttons) {
      btn.classList.toggle('active', btn.dataset.engine === state.engine);
    }
    const isSingbox = state.engine === 'singbox';
    const isMihomo = state.engine === 'mihomo';
    const isTor = state.engine === 'tor';
    const isPsiphon = state.engine === 'psiphon';
    const isOpenvpn = state.engine === 'openvpn';
    // the accent colours follow the selected engine (see style.css [data-engine])
    document.querySelector('.app').dataset.engine = state.engine;
    document.getElementById('quick-presets-card').style.display = (isSingbox || isMihomo || isTor || isPsiphon || isOpenvpn) ? 'none' : '';
    document.getElementById('quick-v2ray-card').style.display = isSingbox ? '' : 'none';
    document.getElementById('quick-mihomo-card').style.display = isMihomo ? '' : 'none';
    document.getElementById('dash-protocol-label').textContent = isSingbox ? 'کانفیگ:' : isMihomo ? 'پروفایل:' : isTor ? 'شبکه:' : 'پروتکل:';
    document.getElementById('dash-scan-label').textContent = isSingbox ? 'نام:' : isMihomo ? 'سرور فعلی:' : isTor ? 'روش:' : 'اسکن:';
    document.getElementById('dash-noize-label').textContent = (isSingbox || isMihomo || isTor) ? 'موتور:' : 'مبهم‌سازی:';
    lastSubTab.configs = isMihomo ? 'mihomo' : isTor ? 'tor' : isPsiphon ? 'psiphon' : isOpenvpn ? 'openvpn' : 'v2ray';
    renderEngineOptions();
  }

  state.engine = await window.aether.getEngine();
  paint();

  for (const btn of buttons) {
    btn.addEventListener('click', async () => {
      const desired = btn.dataset.engine;
      if (desired === state.engine) return;
      try {
        await window.aether.setEngine(desired);
        state.engine = desired;
        paint();
        refreshDashboardMeta();
      } catch (err) {
        await uiAlert(err.message || String(err));
      }
    });
  }

  document.getElementById('dash-goto-mihomo').addEventListener('click', () => {
    document.querySelector('.nav-item[data-tab="mihomo"]').click();
  });
  document.getElementById('dash-goto-v2ray').addEventListener('click', () => {
    document.querySelector('.nav-item[data-tab="v2ray"]').click();
  });
}

async function wireScannerTab() {
  document.getElementById('scan-clear-peer').addEventListener('click', async () => {
    if (!(await uiConfirm('Peer اجباری (هم MASQUE و هم WireGuard) پاک شود و Aether به اسکن خودکار خودش برگردد؟'))) return;
    await window.aether.clearPeer();
    await populateProfiles();
    renderForms();
    await uiAlert('پاک شد. حالا می‌توانید دوباره از تب داشبورد با موتور Aether وصل شوید.');
  });

  async function refreshScannerVersion() {
    const v = await window.aether.getScannerVersion();
    document.getElementById('scanner-version').textContent = v || 'نصب نشده';
  }
  await refreshScannerVersion();

  document.getElementById('scanner-check').addEventListener('click', async () => {
    const statusEl = document.getElementById('scanner-update-status');
    const progressWrap = document.getElementById('scanner-update-progress');
    statusEl.textContent = 'در حال بررسی…';
    try {
      const info = await window.aether.checkScannerUpdate();
      if (!info.updateAvailable) {
        statusEl.textContent = 'اسکنر نصب و به‌روز است.';
        return;
      }
      statusEl.textContent = `در حال دانلود نسخه ${info.latestTag}…`;
      progressWrap.classList.add('active');
      await window.aether.updateScanner();
      statusEl.textContent = 'اسکنر با موفقیت نصب/به‌روزرسانی شد.';
      await refreshScannerVersion();
    } catch (err) {
      statusEl.textContent = `خطا: ${err.message || err}`;
    } finally {
      progressWrap.classList.remove('active');
    }
  });

  window.aether.onScannerUpdateProgress((p) => {
    const bar = document.getElementById('scanner-update-progress-bar');
    bar.style.width = `${Math.round((p.pct || 0) * 100)}%`;
  });

  function renderScanResults(candidates) {
    const container = document.getElementById('scan-results');
    container.innerHTML = '';
    if (!candidates || candidates.length === 0) {
      container.appendChild(el('p', { class: 'muted' }, 'نتیجه‌ای برای نمایش نیست.'));
      return;
    }
    for (const c of candidates) {
      const metaParts = [];
      if (c.latencyMs != null && !Number.isNaN(c.latencyMs)) metaParts.push(`تاخیر: ${c.latencyMs}ms`);
      if (c.lossRate != null && !Number.isNaN(c.lossRate)) metaParts.push(`افت پکت: ${c.lossRate}`);
      if (c.speedMbps != null && !Number.isNaN(c.speedMbps)) metaParts.push(`سرعت: ${c.speedMbps}MB/s`);
      if (c.region) metaParts.push(c.region);

      const portInput = el('input', { class: 'port-input', type: 'text', value: c.port || '443' });
      const row = el('div', { class: 'scan-result-row' }, [
        el('span', { class: 'ip' }, c.ip),
        el('span', { class: 'meta' }, metaParts.join(' · ') || '—'),
        portInput,
        el('button', {
          class: 'btn ghost small',
          onclick: async () => {
            const ok = await uiConfirm(
              `⚠️ این تست فقط دسترسی TCP:443 را سنجیده، نه پروتکل واقعی MASQUE/WARP.\n` +
              `اگر این IP در عمل با پروتکل Aether کار نکند، اتصال ممکن است در حالت «در حال اتصال مجدد» گیر کند.\n\n` +
              `${c.ip}:${portInput.value} به‌عنوان Peer اجباری ثبت شود؟ (در صورت مشکل، از همین تب دکمه‌ی «پاک کردن Peer اجباری» را بزنید.)`
            );
            if (!ok) return;
            await window.aether.applyPeer(c.ip, portInput.value || '443', 'peer');
            await populateProfiles();
            renderForms();
          }
        }, 'استفاده به‌عنوان Peer')
      ]);
      container.appendChild(row);
    }
  }

  document.getElementById('scan-start').addEventListener('click', async () => {
    const statusEl = document.getElementById('scan-status');
    const consoleEl = document.getElementById('scan-console');
    const startBtn = document.getElementById('scan-start');
    const cancelBtn = document.getElementById('scan-cancel');
    const maxLatency = Number(document.getElementById('scan-max-latency').value) || 800;
    const count = Number(document.getElementById('scan-count').value) || 20;
    const maxIpsToScan = Number(document.getElementById('scan-max-ips').value) || null;

    const hasScanner = await window.aether.hasScanner();
    if (!hasScanner) {
      statusEl.textContent = 'ابتدا اسکنر را از بالا دانلود کنید.';
      return;
    }

    startBtn.disabled = true;
    cancelBtn.disabled = false;
    consoleEl.style.display = 'block';
    consoleEl.textContent = '';
    statusEl.textContent = 'در حال اسکن… ممکن است چند دقیقه طول بکشد.';

    try {
      const results = await window.aether.runScan({ maxLatencyMs: maxLatency, count, skipDownloadTest: true, maxIpsToScan });
      statusEl.textContent = `اسکن تمام شد: ${results.length} نتیجه پیدا شد.`;
      renderScanResults(results);
    } catch (err) {
      statusEl.textContent = `خطا در اسکن: ${err.message || err}`;
    } finally {
      startBtn.disabled = false;
      cancelBtn.disabled = true;
    }
  });

  document.getElementById('scan-cancel').addEventListener('click', () => window.aether.cancelScan());

  window.aether.onScannerProgressLine((line) => {
    const consoleEl = document.getElementById('scan-console');
    consoleEl.textContent += line;
    consoleEl.scrollTop = consoleEl.scrollHeight;
  });

  document.getElementById('scan-import').addEventListener('click', async () => {
    const statusEl = document.getElementById('scan-status');
    try {
      const results = await window.aether.importScanFile();
      if (results === null) return; // user cancelled
      statusEl.textContent = `فایل خوانده شد: ${results.length} IP پیدا شد.`;
      renderScanResults(results);
    } catch (err) {
      statusEl.textContent = `خطا در خواندن فایل: ${err.message || err}`;
    }
  });
}

// ---------- Clash / mihomo engine ----------
function pingClass(ms) {
  if (ms == null) return '';
  if (ms === 0) return 'fail';
  return ms < 400 ? 'ok' : ms < 1000 ? 'slow' : 'bad';
}

async function refreshMihomoNodes() {
  const box = document.getElementById('dash-mihomo-nodes');
  if (state.engine !== 'mihomo' || !lastKnownState.running || lastKnownState.status !== 'connected') {
    state.mihomoNow = null;
    return;
  }
  try {
    const { now, type, nodes } = await window.aether.getMihomoNodes();
    state.mihomoNow = now;
    refreshDashboardMeta();
    box.innerHTML = '';
    const sorted = nodes.slice().sort((a, b) => (a.delay || 99999) - (b.delay || 99999));
    for (const n of sorted.slice(0, 40)) {
      const row = el('div', {
        class: `node-row${n.name === now ? ' active' : ''}${type === 'Selector' ? ' selectable' : ''}`,
        onclick: async () => {
          if (type !== 'Selector') return;
          try { await window.aether.selectMihomoNode(n.name); await refreshMihomoNodes(); } catch (err) { await uiAlert(err.message || err); }
        }
      }, [
        el('span', { class: 'name', title: n.name }, n.name),
        n.name === now ? el('span', { class: 'active-tag' }, 'در حال استفاده') : null,
        el('span', { class: `test-result ${pingClass(n.delay)}` }, n.delay == null ? '' : n.delay === 0 ? 'ناموفق' : `${n.delay} ms`)
      ]);
      box.appendChild(row);
    }
    if (!nodes.length) box.appendChild(el('p', { class: 'muted' }, 'هیچ سروری در این پروفایل پیدا نشد.'));
  } catch { /* controller not up yet */ }
}

async function wireTorTab() {
  const statusEl = document.getElementById('tor-install-status');
  const bridgeStatus = document.getElementById('tor-bridges-status');
  async function refresh() {
    const info = await window.aether.getTorInfo();
    state.torMode = info.mode;
    document.getElementById('tor-version').textContent = info.installed ? (info.version || 'نصب‌شده') : 'نصب نشده';
    document.getElementById('tor-mode').value = info.mode;
    const c = info.bridges || {};
    const when = info.bridgesUpdatedAt ? new Date(info.bridgesUpdatedAt).toLocaleString('fa-IR') : 'نسخه‌ی همراه برنامه';
    document.getElementById('tor-bridge-info').textContent = `پل‌ها: obfs4 ${c.obfs4 || 0} · webtunnel ${c.webtunnel || 0} · ساده ${c.vanilla || 0} · snowflake ${c.snowflake || 0} · آخرین به‌روزرسانی: ${when}`;
    refreshDashboardMeta();
  }
  await refresh();

  document.getElementById('tor-mode').addEventListener('change', async (e) => {
    await window.aether.setTorMode(e.target.value);
    state.torMode = e.target.value;
    refreshDashboardMeta();
  });
  document.getElementById('tor-install').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const wrap = document.getElementById('tor-install-progress');
    btn.disabled = true;
    statusEl.textContent = 'در حال دانلود Tor (حدود ۴۰ مگابایت)… اگر GitHub/سایت Tor فیلتر است، ابتدا با یک موتور دیگر وصل شوید.';
    wrap.classList.add('active');
    try {
      const r = await window.aether.installTor();
      statusEl.textContent = r && r.updated === false ? `Tor نسخه‌ی ${r.version} از قبل نصب است؛ دانلود لازم نبود.` : 'Tor نصب شد.';
      await refresh();
    } catch (err) {
      statusEl.textContent = `خطا: ${err.message || err}`;
    } finally {
      btn.disabled = false;
      wrap.classList.remove('active');
    }
  });
  window.aether.onTorInstallProgress((p) => {
    document.getElementById('tor-install-progress-bar').style.width = `${Math.round((p.pct || 0) * 100)}%`;
  });
  document.getElementById('tor-manual').addEventListener('click', async () => {
    try {
      if (await window.aether.pickTorArchive()) {
        statusEl.textContent = 'فایل انتخاب‌شده نصب شد.';
        await refresh();
      }
    } catch (err) {
      statusEl.textContent = `خطا: ${err.message || err}`;
    }
  });
  document.getElementById('tor-bridges-update').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    bridgeStatus.textContent = 'در حال دریافت پل‌ها…';
    try {
      await window.aether.updateTorBridges();
      bridgeStatus.textContent = 'پل‌ها به‌روز شدند.';
      await refresh();
    } catch (err) {
      bridgeStatus.textContent = `خطا: ${err.message || err}`;
    } finally {
      btn.disabled = false;
    }
  });
}

async function wireMihomoTab() {
  const statusEl = document.getElementById('mihomo-update-status');
  async function refreshVersion() {
    const has = await window.aether.hasMihomo();
    const v = await window.aether.getMihomoVersion();
    document.getElementById('mihomo-version').textContent = has ? (v || 'نصب‌شده') : 'نصب نشده';
  }
  await refreshVersion();

  document.getElementById('mihomo-check').addEventListener('click', async () => {
    const progressWrap = document.getElementById('mihomo-update-progress');
    statusEl.textContent = 'در حال بررسی و دانلود…';
    progressWrap.classList.add('active');
    try {
      const res = await window.aether.updateMihomo();
      statusEl.textContent = res.updated ? `mihomo ${res.info.latestTag} نصب شد.` : 'mihomo نصب و به‌روز است.';
      await refreshVersion();
    } catch (err) {
      statusEl.textContent = `خطا: ${err.message || err}`;
    } finally {
      progressWrap.classList.remove('active');
    }
  });
  window.aether.onMihomoUpdateProgress((p) => {
    document.getElementById('mihomo-update-progress-bar').style.width = `${Math.round((p.pct || 0) * 100)}%`;
  });
  document.getElementById('mihomo-manual').addEventListener('click', async () => {
    if (await window.aether.pickMihomoExeManually()) {
      statusEl.textContent = 'فایل انتخاب‌شده جایگزین شد.';
      await refreshVersion();
    }
  });

  const addStatus = document.getElementById('mihomo-add-status');
  const groupType = () => document.getElementById('mihomo-group-type').value;

  async function refreshList() {
    const { profiles, activeId } = await window.aether.listMihomoProfiles();
    const list = document.getElementById('mihomo-profile-list');
    list.innerHTML = '';
    const entries = Object.values(profiles);
    if (!entries.length) list.appendChild(el('p', { class: 'muted' }, 'هنوز پروفایلی اضافه نشده.'));
    const GROUP_LABEL = { 'url-test': 'سریع‌ترین', fallback: 'fallback', 'load-balance': 'پخش بار', select: 'دستی' };
    for (const prof of entries) {
      const isActive = prof.id === activeId;
      list.appendChild(el('div', {
        class: `v2ray-row${isActive ? ' active' : ''}`,
        onclick: async () => { await window.aether.setActiveMihomoProfile(prof.id); await refreshList(); }
      }, [
        el('div', { class: 'row-top' }, [
          el('span', { class: 'badge proto-clash' }, 'CLASH'),
          el('span', { class: 'name', title: prof.name }, prof.name),
          isActive ? el('span', { class: 'active-tag' }, '✓ فعال') : null
        ]),
        el('div', { class: 'row-actions' }, [
          el('span', { class: 'test-result' }, GROUP_LABEL[prof.groupType] || prof.groupType),
          el('span', { class: 'spacer' }),
          prof.sourceUrl ? el('button', {
            class: 'btn ghost small',
            onclick: async (e) => {
              e.stopPropagation();
              e.target.disabled = true;
              try { await window.aether.refreshMihomoProfile(prof.id); addStatus.textContent = `«${prof.name}» به‌روز شد (برای اعمال، دوباره وصل شوید).`; }
              catch (err) { addStatus.textContent = `خطا: ${err.message || err}`; }
              e.target.disabled = false;
            }
          }, '↻ به‌روزرسانی') : null,
          el('button', {
            class: 'btn ghost small danger',
            onclick: async (e) => {
              e.stopPropagation();
              if (!(await uiConfirm(`پروفایل «${prof.name}» حذف شود؟`))) return;
              await window.aether.deleteMihomoProfile(prof.id);
              await refreshList();
            }
          }, 'حذف')
        ])
      ]));
    }
    state.activeMihomoProfileObj = activeId ? profiles[activeId] || null : null;
    refreshDashboardMeta();
  }

  document.getElementById('mihomo-sub-add').addEventListener('click', async () => {
    const url = document.getElementById('mihomo-sub-url').value.trim();
    if (!url) return;
    addStatus.textContent = 'در حال دریافت سابسکریپشن…';
    try {
      const prof = await window.aether.addMihomoUrl({ url, groupType: groupType() });
      addStatus.textContent = `پروفایل «${prof.name}» اضافه شد.`;
      document.getElementById('mihomo-sub-url').value = '';
      await refreshList();
    } catch (err) {
      addStatus.textContent = `خطا در دریافت: ${err.message || err}`;
    }
  });
  document.getElementById('mihomo-text-add').addEventListener('click', async () => {
    const text = document.getElementById('mihomo-text').value;
    try {
      const prof = await window.aether.addMihomoText({ text, groupType: groupType() });
      addStatus.textContent = `پروفایل «${prof.name}» اضافه شد.`;
      document.getElementById('mihomo-text').value = '';
      await refreshList();
    } catch (err) {
      addStatus.textContent = `خطا: ${err.message || err}`;
    }
  });
  document.getElementById('dash-mihomo-test').addEventListener('click', async () => {
    try { await window.aether.testMihomoNodes(); } catch { /* not connected */ }
    await refreshMihomoNodes();
  });

  await refreshList();
  setInterval(refreshMihomoNodes, 5000);
}

async function wireV2rayTab() {
  async function refreshSingboxVersion() {
    const v = await window.aether.getSingboxVersion();
    document.getElementById('singbox-version').textContent = v || 'نصب نشده';
  }
  await refreshSingboxVersion();

  document.getElementById('singbox-check').addEventListener('click', async () => {
    const statusEl = document.getElementById('singbox-update-status');
    const progressWrap = document.getElementById('singbox-update-progress');
    statusEl.textContent = 'در حال بررسی…';
    try {
      const info = await window.aether.checkSingboxUpdate();
      if (!info.updateAvailable) {
        statusEl.textContent = 'sing-box نصب و به‌روز است.';
        return;
      }
      statusEl.textContent = `در حال دانلود نسخه ${info.latestTag}…`;
      progressWrap.classList.add('active');
      await window.aether.updateSingbox();
      statusEl.textContent = 'sing-box با موفقیت نصب/به‌روزرسانی شد.';
      await refreshSingboxVersion();
    } catch (err) {
      statusEl.textContent = `خطا: ${err.message || err}`;
    } finally {
      progressWrap.classList.remove('active');
    }
  });

  window.aether.onSingboxUpdateProgress((p) => {
    const bar = document.getElementById('singbox-update-progress-bar');
    bar.style.width = `${Math.round((p.pct || 0) * 100)}%`;
  });

  document.getElementById('singbox-manual').addEventListener('click', async () => {
    const picked = await window.aether.pickSingboxExeManually();
    if (picked) {
      document.getElementById('singbox-update-status').textContent = 'فایل sing-box.exe انتخاب‌شده جایگزین شد.';
      await refreshSingboxVersion();
    }
  });

  function formatTestResult(result) {
    if (!result) return { text: '', cls: '' };
    if (result.ok) {
      const ms = result.latencyMs;
      return { text: `${ms} ms`, cls: ms < 400 ? 'ok' : ms < 1000 ? 'slow' : 'bad', title: result.at ? `آخرین تست: ${new Date(result.at).toLocaleString('fa-IR')}` : '' };
    }
    return { text: 'ناموفق', cls: 'fail', title: `${result.error || 'خطا'}${result.at ? ` — ${new Date(result.at).toLocaleString('fa-IR')}` : ''}` };
  }

  async function refreshConfigList() {
    const { configs, activeId, groups = {}, testResults = {} } = await window.aether.listV2rayConfigs();
    // Saved results from earlier sessions fill in; fresher in-memory ones win.
    state.testResults = { ...testResults, ...(state.testResults || {}) };
    const container = document.getElementById('v2ray-config-list');
    container.innerHTML = '';
    const entries = Object.values(configs);
    const rowsByGroup = {};
    if (entries.length === 0) {
      container.appendChild(el('p', { class: 'muted' }, 'هنوز کانفیگی اضافه نشده.'));
    }
    if (!state.testResults) state.testResults = {};
    const buildRow = (cfg) => {
      const isActive = cfg.id === activeId;
      const resultEl = el('span', { class: 'test-result' }, '');
      const prev = state.testResults[cfg.id];
      if (prev) { const f = formatTestResult(prev); resultEl.className = `test-result ${f.cls}`; resultEl.textContent = f.text; resultEl.title = f.title || ''; }

      const testBtn = el('button', {
        class: 'btn ghost small',
        onclick: async (e) => {
          e.stopPropagation();
          resultEl.className = 'test-result testing';
          resultEl.textContent = 'تست…';
          try {
            const result = await window.aether.testV2rayConfig(cfg.id);
            state.testResults[cfg.id] = result;
            const { text, cls, title } = formatTestResult(result);
            resultEl.className = `test-result ${cls}`;
            resultEl.textContent = text;
            resultEl.title = title || '';
          } catch (err) {
            resultEl.className = 'test-result fail';
            resultEl.textContent = 'ناموفق';
            resultEl.title = err.message || String(err);
          }
        }
      }, '⚡ پینگ');

      const isTlsBased = !!(cfg.outbound && cfg.outbound.tls);
      const fragOn = isTlsBased && cfg.outbound.tls.record_fragment;
      const fragBtn = isTlsBased ? el('button', {
        class: `btn ghost small${fragOn ? '' : ''}`,
        title: 'فرگمنت TLS برای دور زدن مسدودسازی فعال',
        onclick: async (e) => {
          e.stopPropagation();
          try {
            await window.aether.setV2rayFragment(cfg.id, { recordFragment: !fragOn, fragment: false });
            await refreshConfigList();
          } catch (err) {
            await uiAlert(err.message || String(err));
          }
        }
      }, fragOn ? 'فرگمنت ✓' : 'فرگمنت ✕') : null;

      const row = el('div', {
        class: `v2ray-row${isActive ? ' active' : ''}`,
        onclick: async () => {
          await window.aether.setActiveV2rayConfig(cfg.id);
          await refreshConfigList();
          if (state.engine === 'singbox') {
            state.activeV2rayConfigObj = cfg;
            refreshDashboardMeta();
          }
        }
      }, [
        el('div', { class: 'row-top' }, [
          el('span', { class: `badge proto-${String(cfg.protocol).toLowerCase()}` }, cfg.protocol),
          el('span', { class: 'name', title: cfg.name }, cfg.name),
          el('button', {
            class: `fav-btn${cfg.favorite ? ' on' : ''}`,
            title: cfg.favorite ? 'حذف از علاقه‌مندی‌ها' : 'افزودن به علاقه‌مندی‌ها',
            onclick: async (e) => { e.stopPropagation(); await window.aether.toggleV2rayFavorite(cfg.id); await refreshConfigList(); }
          }, cfg.favorite ? '★' : '☆'),
          isActive ? el('span', { class: 'active-tag' }, '✓ فعال') : null
        ]),
        el('div', { class: 'row-actions' }, [
        resultEl,
        el('span', { class: 'spacer' }),
        fragBtn,
        testBtn,
        el('button', {
          class: 'btn ghost small danger',
          onclick: async (e) => {
            e.stopPropagation();
            if (!(await uiConfirm(`کانفیگ «${cfg.name}» حذف شود؟`))) return;
            await window.aether.deleteV2rayConfig(cfg.id);
            await refreshConfigList();
          }
        }, 'حذف')
        ])
      ]);
      row.dataset.configId = cfg.id;
      return row;
    };
    const sortRows = (list) => (state.sortByPing
      ? [...list].sort((a, b) => {
          const ra = state.testResults[a.id]; const rb = state.testResults[b.id];
          const va = ra && ra.ok ? ra.latencyMs : Infinity; const vb = rb && rb.ok ? rb.latencyMs : Infinity;
          return va - vb;
        })
      : list);
    for (const cfg of sortRows(entries)) {
      (rowsByGroup[cfg.groupId || '_legacy'] = rowsByGroup[cfg.groupId || '_legacy'] || []).push(buildRow(cfg));
    }
    const favs = sortRows(entries.filter((c) => c.favorite));
    if (favs.length) {
      renderConfigGroup(container, { id: '_fav', name: '⭐ علاقه‌مندی‌ها', favorites: true, legacy: true }, favs.map(buildRow));
    }

    // One collapsible block per subscription / paste / file, newest first;
    // configs saved before groups existed land in a "legacy" block.
    const groupList = Object.values(groups).sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
    if (rowsByGroup._legacy) groupList.push({ id: '_legacy', name: 'قدیمی (بدون گروه)', legacy: true });
    for (const group of groupList) {
      const rows = rowsByGroup[group.id] || [];
      if (!rows.length && !group.legacy) continue;
      renderConfigGroup(container, group, rows);
    }

    // Keep the dashboard's "active config" cache in sync even if the
    // active id came from a previous session (not just a fresh click).
    if (activeId && configs[activeId]) {
      state.activeV2rayConfigObj = configs[activeId];
    } else {
      state.activeV2rayConfigObj = null;
    }
    if (state.engine === 'singbox') refreshDashboardMeta();
  }

  function renderConfigGroup(container, group, rows) {
    if (!state.groupSeen) state.groupSeen = new Set();
    if (!state.collapsedGroups) state.collapsedGroups = new Set();
    if (!state.groupSeen.has(group.id)) {
      state.groupSeen.add(group.id);
      if (rows.length > 12 && !group.favorites) state.collapsedGroups.add(group.id); // big subs start folded
    }
    const collapsed = state.collapsedGroups.has(group.id);
    const realId = group.legacy ? null : group.id;

    const body = el('div', { class: 'group-body' }, rows);
    body.style.display = collapsed ? 'none' : '';

    const nameEl = el('span', { class: 'group-name', title: 'برای تغییر نام دوبار کلیک کنید' }, group.name);
    if (!group.legacy) {
      nameEl.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const input = el('input', { type: 'text', class: 'group-rename', value: group.name });
        const commit = async () => {
          const v = input.value.trim();
          if (v && v !== group.name) await window.aether.renameV2rayGroup(group.id, v);
          await refreshConfigList();
        };
        input.addEventListener('click', (ev) => ev.stopPropagation());
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(); if (ev.key === 'Escape') refreshConfigList(); });
        input.addEventListener('blur', commit);
        nameEl.replaceWith(input);
        input.focus();
        input.select();
      });
    }

    const head = el('div', {
      class: 'group-head',
      onclick: () => {
        const nowCollapsed = body.style.display !== 'none';
        body.style.display = nowCollapsed ? 'none' : '';
        head.classList.toggle('collapsed', nowCollapsed);
        if (nowCollapsed) state.collapsedGroups.add(group.id); else state.collapsedGroups.delete(group.id);
      }
    }, [
      el('span', { class: 'chev' }, '▾'),
      nameEl,
      el('span', { class: 'badge' }, String(rows.length)),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn ghost small',
        title: 'تست پینگ همه‌ی کانفیگ‌های این گروه',
        onclick: async (e) => {
          e.stopPropagation();
          const testGroupBtn = e.currentTarget;
          testGroupBtn.disabled = true;
          rows.forEach((r) => { const t = r.querySelector('.test-result'); if (t) { t.className = 'test-result testing'; t.textContent = 'در صف…'; } });
          try { await (group.favorites ? window.aether.testFavoriteV2rayConfigs() : window.aether.testV2rayGroup(realId)); } catch (err) { await uiAlert(err.message || err); }
          testGroupBtn.disabled = false;
        }
      }, '⚡ تست'),
      group.sourceUrl ? el('button', {
        class: 'btn ghost small',
        title: 'دوباره از لینک سابسکریپشن دریافت شود',
        onclick: async (e) => {
          e.stopPropagation();
          e.currentTarget.disabled = true;
          try {
            const r = await window.aether.refreshV2rayGroup(group.id, {
              recordFragment: document.getElementById('v2ray-record-fragment').checked,
              fragment: document.getElementById('v2ray-fragment').checked
            });
            document.getElementById('v2ray-sub-status').textContent = `«${group.name}» به‌روز شد: ${r.added} کانفیگ.`;
          } catch (err) {
            document.getElementById('v2ray-sub-status').textContent = `خطا: ${err.message || err}`;
          }
          await refreshConfigList();
        }
      }, '↻') : null,
      group.favorites ? null : el('button', {
        class: 'btn ghost small danger',
        title: 'حذف کل این گروه',
        onclick: async (e) => {
          e.stopPropagation();
          if (!(await uiConfirm(`گروه «${group.name}» با ${rows.length} کانفیگ کلاً حذف شود؟`))) return;
          try { await window.aether.deleteV2rayGroup(realId); } catch (err) { await uiAlert(err.message || err); }
          await refreshConfigList();
        }
      }, 'حذف گروه')
    ]);
    head.classList.toggle('collapsed', collapsed);
    container.appendChild(el('div', { class: `group${group.favorites ? ' fav-group' : ''}` }, [head, body]));
  }

  // Rows still marked "queued" go back to their last saved result (or blank).
  function resetQueuedRows() {
    document.querySelectorAll('#v2ray-config-list .test-result.testing').forEach((elm) => {
      const row = elm.closest('[data-config-id]');
      const prev = row && (state.testResults || {})[row.dataset.configId];
      const f = prev ? formatTestResult(prev) : { text: '', cls: '' };
      elm.className = `test-result ${f.cls}`;
      elm.textContent = f.text;
      elm.title = f.title || '';
    });
  }

  document.getElementById('v2ray-warp-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const statusEl = document.getElementById('v2ray-warp-status');
    btn.disabled = true;
    statusEl.textContent = 'در حال ساخت اکانت WARP…';
    try {
      await window.aether.addWarpConfig();
      statusEl.textContent = 'WARP اضافه شد. در گروه «Cloudflare WARP» است؛ پینگ بگیرید و انتخابش کنید.';
      await refreshConfigList();
    } catch (err) {
      statusEl.textContent = `خطا: ${err.message || err}`;
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('v2ray-test-all').addEventListener('click', async () => {
    document.querySelectorAll('#v2ray-config-list .test-result').forEach((elm) => {
      elm.className = 'test-result testing';
      elm.textContent = 'در صف…';
    });
    try {
      await window.aether.testAllV2rayConfigs();
    } catch (err) {
      await uiAlert(`خطا در تست دسته‌جمعی: ${err.message || err}`);
      resetQueuedRows();
    }
  });

  document.getElementById('v2ray-test-cancel').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'در حال توقف…';
    await window.aether.cancelV2rayTests();
  });

  document.getElementById('v2ray-sort-ping').addEventListener('click', async (e) => {
    state.sortByPing = !state.sortByPing;
    e.currentTarget.classList.toggle('active', state.sortByPing);
    await refreshConfigList();
  });

  // Live progress bar: "N of M" + stop button while a test run is active.
  window.aether.onV2rayTestRun(({ state: runState, total, done, otherTun }) => {
    if (runState === 'start') {
      const warn = document.getElementById('v2ray-test-warning');
      warn.hidden = !otherTun;
      warn.textContent = 'یک VPN یا TUN دیگر روی این کامپیوتر روشن است (به اتصال‌های ناموجود هم جواب می‌دهد). نتیجه‌ی تست از مسیر همان برنامه است، نه اینترنت مستقیم؛ برای نتیجه‌ی دقیق آن را خاموش کنید.';
    }
    const box = document.getElementById('v2ray-test-progress');
    const cancelBtn = document.getElementById('v2ray-test-cancel');
    const label = document.getElementById('v2ray-test-progress-text');
    const bar = document.getElementById('v2ray-test-progress-bar');
    document.getElementById('v2ray-test-all').disabled = runState === 'start' || runState === 'progress';
    if (runState === 'start' || runState === 'progress') {
      box.hidden = false;
      cancelBtn.hidden = false;
      if (runState === 'start') { cancelBtn.disabled = false; cancelBtn.textContent = '⏹ توقف'; }
      label.textContent = `${done} از ${total} تست شد · ${total - done} باقی‌مانده`;
      bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
      return;
    }
    cancelBtn.hidden = true;
    label.textContent = runState === 'cancelled'
      ? `تست متوقف شد: ${done} از ${total} انجام شد.`
      : `تست کامل شد: ${done} کانفیگ.`;
    bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    // Rows that were still queued go back to blank.
    resetQueuedRows();
    if (state.sortByPing) refreshConfigList();
    setTimeout(() => { if (cancelBtn.hidden) box.hidden = true; }, 8000);
  });

  window.aether.onV2rayTestProgress(({ id, result }) => {
    if (!state.testResults) state.testResults = {};
    state.testResults[id] = result;
    const { text, cls, title } = formatTestResult(result);
    document.querySelectorAll(`#v2ray-config-list [data-config-id="${id}"] .test-result`).forEach((resultEl) => {
      resultEl.className = `test-result ${cls}`;
      resultEl.textContent = text;
      resultEl.title = title || '';
    });
  });
  await refreshConfigList();

  function formatImportStatus(added, errors, warnings) {
    let text = `${added} کانفیگ اضافه شد.`;
    if (errors && errors.length) text += ` (${errors.length} مورد قابل تشخیص نبود)`;
    if (warnings && warnings.length) text += ` ⚠️ ${warnings.map((w) => w.warning).join(' ')}`;
    return text;
  }

  document.getElementById('v2ray-import-btn').addEventListener('click', async () => {
    const textarea = document.getElementById('v2ray-import-text');
    const statusEl = document.getElementById('v2ray-import-status');
    const text = textarea.value.trim();
    if (!text) return;
    const options = {
      recordFragment: document.getElementById('v2ray-record-fragment').checked,
      fragment: document.getElementById('v2ray-fragment').checked,
      groupName: document.getElementById('v2ray-import-name').value.trim() || undefined
    };
    try {
      const { added, errors, warnings } = await window.aether.importV2rayLink(text, options);
      statusEl.textContent = formatImportStatus(added, errors, warnings);
      if (added > 0) { textarea.value = ''; document.getElementById('v2ray-import-name').value = ''; }
      await refreshConfigList();
    } catch (err) {
      statusEl.textContent = `خطا: ${err.message || err}`;
    }
  });

  document.getElementById('v2ray-import-conf-file-btn').addEventListener('click', async () => {
    const statusEl = document.getElementById('v2ray-import-status');
    const options = {
      recordFragment: document.getElementById('v2ray-record-fragment').checked,
      fragment: document.getElementById('v2ray-fragment').checked
    };
    try {
      const result = await window.aether.importV2rayConfFile(options);
      if (result === null) return; // user cancelled
      statusEl.textContent = formatImportStatus(result.added, result.errors, result.warnings);
      await refreshConfigList();
    } catch (err) {
      statusEl.textContent = `خطا: ${err.message || err}`;
    }
  });

  document.getElementById('v2ray-sub-fetch-btn').addEventListener('click', async () => {
    const urlInput = document.getElementById('v2ray-sub-url');
    const statusEl = document.getElementById('v2ray-sub-status');
    const url = urlInput.value.trim();
    if (!url) return;
    const options = {
      recordFragment: document.getElementById('v2ray-record-fragment').checked,
      fragment: document.getElementById('v2ray-fragment').checked,
      groupName: document.getElementById('v2ray-sub-name').value.trim() || undefined
    };
    statusEl.textContent = 'در حال دریافت سابسکریپشن…';
    try {
      const { added, errors, warnings } = await window.aether.importV2rayFromUrl(url, options);
      statusEl.textContent = formatImportStatus(added, errors, warnings);
      if (added > 0) { urlInput.value = ''; document.getElementById('v2ray-sub-name').value = ''; }
      await refreshConfigList();
    } catch (err) {
      statusEl.textContent = `خطا در دریافت: ${err.message || err}`;
    }
  });
}

/** Error text for the screen: Electron's IPC prefix, raw HTML/JSON bodies and huge headers are cut away. */
function shortError(msg) {
  let s = String(msg).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  if (/\b404\b/.test(s)) return 'فایل یا نسخه‌ی موردنظر پیدا نشد (۴۰۴).';
  const cut = s.search(/[<{]/);
  if (cut > 20) s = s.slice(0, cut);
  return s.length > 220 ? `${s.slice(0, 220)}…` : s.trim();
}
// ---------- Home: options of the selected engine (replaces the proxy/TUN switch, now in Settings) ----------
let optsRunning = null;
async function renderEngineOptions() {
  const box = document.getElementById('engine-options');
  if (!box) return;
  const disabled = !!lastKnownState.running;
  optsRunning = disabled;
  const rows = [];
  const row = (label, control) => rows.push(el('div', { class: 'opt-row' }, [el('span', { class: 'opt-label' }, label), control]));
  const select = (opts, value, onChange) => {
    const s = el('select', { class: 'opt-select' });
    for (const [v, l] of opts) { const o = el('option', { value: v }, l); if (v === value) o.selected = true; s.appendChild(o); }
    s.disabled = disabled;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  };
  const engine = state.engine;
  if (engine === 'aether') {
    const cur = state.currentSettings;
    row('پروتکل', select([['masque', 'MASQUE'], ['wg', 'WireGuard'], ['gool', 'WARP×2 (gool)']], cur.AETHER_PROTOCOL || 'masque', (v) => { setSetting('AETHER_PROTOCOL', v); renderForms(); refreshDashboardMeta(); }));
    row('حالت اسکن', select([['turbo', 'سریع'], ['balanced', 'متعادل'], ['thorough', 'کامل'], ['stealth', 'مخفی'], ['ironclad', 'ironclad']], cur.AETHER_SCAN || 'balanced', (v) => { setSetting('AETHER_SCAN', v); renderForms(); refreshDashboardMeta(); }));
  } else if (engine === 'openvpn') {
    const data = await window.aether.listOpenvpn();
    if (data.profiles.length) {
      row('کانفیگ', select(data.profiles.map((p) => [p.id, p.name]), data.active, async (v) => {
        await window.aether.setActiveOpenvpn(v);
        await refreshOpenvpnTab();
      }));
    } else rows.push(el('p', { class: 'muted hint' }, 'هنوز کانفیگ OpenVPN اضافه نشده (کانفیگ‌ها › OpenVPN).'));
    if (!data.exe) rows.push(el('p', { class: 'muted hint' }, '⚠ برنامه‌ی رسمی OpenVPN نصب نیست (کانفیگ‌ها › OpenVPN).'));
  } else if (engine === 'psiphon') {
    const info = await window.aether.getPsiphonInfo();
    const save = async (patch) => {
      const next = { route: info.route, mode: info.mode, region: info.region, ...patch };
      Object.assign(info, next);
      await window.aether.setPsiphon(next);
      // keep the Psiphon tab in step
      document.getElementById('psiphon-route').value = next.route;
      document.getElementById('psiphon-mode').value = next.mode;
      document.getElementById('psiphon-region').value = next.region;
      state.psiphonRoute = next.route;
      refreshDashboardMeta();
    };
    row('مسیر', select([['aether', 'از طریق Aether (WARP)'], ['only', 'فقط سایفون']], info.route, (v) => save({ route: v })));
    row('روش', select([['auto', 'خودکار'], ['cdn', 'فقط CDN'], ['direct', 'مستقیم']], info.mode, (v) => save({ mode: v })));
    const regions = [...document.querySelectorAll('#psiphon-region option')].map((o) => [o.value, o.textContent]);
    row('کشور خروجی', select(regions, info.region, (v) => save({ region: v })));
  } else if (engine === 'tor') {
    const modes = [...document.querySelectorAll('#tor-mode option')].map((o) => [o.value, o.textContent]);
    row('روش اتصال', select(modes, state.torMode || 'auto', async (v) => {
      await window.aether.setTorMode(v);
      state.torMode = v;
      document.getElementById('tor-mode').value = v;
      refreshDashboardMeta();
    }));
  } else if (engine === 'mihomo') {
    const data = await window.aether.listMihomoProfiles();
    const profiles = Object.values(data.profiles || {});
    if (!profiles.length) rows.push(el('p', { class: 'muted opt-empty' }, 'هنوز پروفایل Clash ندارید؛ از «کانفیگ‌ها › Clash» اضافه کنید.'));
    else row('پروفایل', select(profiles.map((p) => [p.id, p.name]), data.activeId || '', async (v) => {
      await window.aether.setActiveMihomoProfile(v);
      state.activeMihomoProfileObj = (data.profiles || {})[v] || null;
      refreshDashboardMeta();
    }));
  } else if (engine === 'singbox') {
    const cfg = state.activeV2rayConfigObj;
    row('سرور', el('span', { class: 'opt-value' }, cfg ? cfg.name : 'انتخاب نشده (کانفیگ‌ها › V2ray)'));
    const dpiTab = document.getElementById('v2ray-dpi-smart');
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!(dpiTab && dpiTab.checked);
    cb.addEventListener('change', async () => { await window.aether.setUiPrefs({ dpiSmart: cb.checked }); if (dpiTab) dpiTab.checked = cb.checked; });
    row('ضد DPI هوشمند', cb);
  }
  box.replaceChildren(...rows);
}

// ---------- Live stats + quick actions (home) ----------
function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
}
function resetStats() {
  for (const id of ['st-ping', 'st-down', 'st-up']) document.getElementById(id).textContent = '—';
  for (const id of ['st-down-total', 'st-up-total']) document.getElementById(id).textContent = '';
  document.getElementById('st-ping').className = '';
  document.getElementById('st-ip').textContent = 'آی‌پی خروجی پس از اتصال نمایش داده می‌شود';
}
async function probeStats() {
  const ping = document.getElementById('st-ping');
  ping.textContent = '…';
  const r = await window.aether.probeStats().catch(() => null);
  if (!lastKnownState.running) return;
  ping.textContent = r ? `${r.ms} ms` : '✗';
  ping.className = !r ? 'bad' : r.ms < 400 ? 'good' : r.ms < 1000 ? 'warn' : 'bad';
  // Windows fonts draw flag emoji as two letters, so the country code is shown as text
  document.getElementById('st-ip').textContent = r ? `${r.ip}${r.cc ? ` · ${r.cc}` : ''}` : 'آی‌پی خروجی دریافت نشد';
}
let statsTimer = null;
function wireLiveStats() {
  window.aether.onStats((s) => {
    if (!lastKnownState.running) return;
    document.getElementById('st-down').textContent = `${fmtBytes(s.down)}/s`;
    document.getElementById('st-up').textContent = `${fmtBytes(s.up)}/s`;
    document.getElementById('st-down-total').textContent = `مجموع ${fmtBytes(s.totalDown)}`;
    document.getElementById('st-up-total').textContent = `مجموع ${fmtBytes(s.totalUp)}`;
  });
  window.aether.onTunnelVerify((d) => {
    clearInterval(statsTimer);
    if (d && d.status === 'ok') { probeStats(); statsTimer = setInterval(probeStats, 30000); } else resetStats();
  });
  document.getElementById('qa-ping').addEventListener('click', probeStats);
  document.getElementById('qa-reconnect').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    await window.aether.stopCore();
    for (let i = 0; i < 30 && (await window.aether.getCoreState()).running; i++) await new Promise((r) => setTimeout(r, 200));
    try { await window.aether.startCore(); } catch (err) { await uiAlert(err.message || String(err)); }
  });
}
function paintQuickActions(state) {
  const connected = state.status === 'connected';
  if (!!state.running !== optsRunning) renderEngineOptions();
  document.getElementById('qa-ping').disabled = !connected;
  document.getElementById('qa-reconnect').disabled = !connected;
  if (!state.running) { clearInterval(statsTimer); resetStats(); }
}

// ---------- Traffic routing (Iran direct) ----------
const ROUTING_HINTS = {
  iran: 'سایت‌های ‎.ir، سایت‌های ایرانی و آی‌پی‌های ایران مستقیم (بیرون از VPN) باز می‌شوند؛ بقیه، مثل تلگرام و یوتیوب، از VPN. در حالت پراکسی سیستم و TUN هر دو کار می‌کند و به هسته‌ی sing-box (تب V2ray) نیاز دارد.',
  all: 'همه‌ی ترافیک از VPN می‌رود.',
  custom: 'فقط دامنه‌ها و آی‌پی‌های لیست «همیشه از VPN» از تونل می‌روند؛ بقیه مستقیم.'
};
function paintRouteChip(mode) {
  const chip = document.getElementById('route-chip');
  chip.hidden = mode === 'all';
  chip.textContent = mode === 'iran' ? 'ایران: مستقیم · بقیه: VPN' : 'فقط لیست من از VPN';
}
async function wireRoutingCard() {
  const r = await window.aether.getRouting();
  const mode = document.getElementById('routing-mode');
  const direct = document.getElementById('routing-direct');
  const proxy = document.getElementById('routing-proxy');
  const hint = document.getElementById('routing-hint');
  const ver = document.getElementById('routing-version');
  mode.value = r.mode; direct.value = r.direct; proxy.value = r.proxy;
  const paint = () => {
    hint.textContent = ROUTING_HINTS[mode.value] + (mode.value !== 'all' && !r.hasSingbox ? ' (هسته‌ی sing-box هنوز نصب نیست.)' : '');
    ver.textContent = mode.value === 'iran' ? `نسخه‌ی قوانین: ${r.version}` : '';
    paintRouteChip(mode.value);
  };
  paint();
  mode.addEventListener('change', async () => { await window.aether.setRouting({ mode: mode.value }); paint(); });
  direct.addEventListener('change', () => window.aether.setRouting({ direct: direct.value }));
  proxy.addEventListener('change', () => window.aether.setRouting({ proxy: proxy.value }));
  document.getElementById('routing-update').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    ver.textContent = 'در حال دریافت…';
    try { r.version = await window.aether.updateRoutingRules(); ver.textContent = `به‌روز شد: ${r.version}`; } catch (err) { ver.textContent = `به‌روزرسانی نشد: ${shortError(err.message || err)}`; }
    btn.disabled = false;
  });
  const out = document.getElementById('routing-test-result');
  document.getElementById('routing-test').addEventListener('click', async () => {
    const host = document.getElementById('routing-test-host').value;
    if (!host.trim()) return;
    // the tester reads the saved lists, so save any edit first
    await window.aether.setRouting({ direct: direct.value, proxy: proxy.value });
    const why = await window.aether.explainRoute(host);
    out.textContent = why ? `مستقیم: ${why}` : 'از VPN';
  });
}
// ---------- Tor: the user's own bridges ----------
async function wireCustomBridges() {
  const ta = document.getElementById('tor-custom');
  const only = document.getElementById('tor-only-mine');
  const count = document.getElementById('tor-custom-count');
  const out = document.getElementById('tor-custom-result');
  const cur = await window.aether.getCustomBridges();
  ta.value = cur.text; only.checked = cur.onlyMine;
  // one result per line; the cert part of a line is never shown
  const paint = (verdicts) => {
    out.replaceChildren(...verdicts.map((v, i) => el('div', { class: v.ok ? 'ok' : 'bad' }, `خط ${i + 1}: ${v.ok ? '✓' : '✗'} ${v.reason}`)));
    count.textContent = verdicts.length ? `${verdicts.filter((v) => v.ok).length} پل درست از ${verdicts.length} خط` : '';
  };
  paint(await window.aether.checkBridges(ta.value));
  let timer = null;
  ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(async () => paint(await window.aether.checkBridges(ta.value)), 300); });
  const save = async () => { paint(await window.aether.setCustomBridges(ta.value, only.checked)); count.textContent += ' · ذخیره شد'; };
  document.getElementById('tor-custom-save').addEventListener('click', save);
  only.addEventListener('change', save);
}
// ---------- Data usage history ----------
const ENGINE_NAMES = { aether: 'Aether', singbox: 'V2ray', mihomo: 'Clash', tor: 'Tor', psiphon: 'سایفون', openvpn: 'OpenVPN', awg: 'AmneziaWG', other: 'دیگر' };

async function wireTrafficTab() {
  let view = 'hour';
  const fromEl = document.getElementById('traffic-from');
  const toEl = document.getElementById('traffic-to');
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  toEl.value = iso(today);
  fromEl.value = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6));
  const query = () => {
    const q = { view };
    if (view === 'range') { q.from = new Date(`${fromEl.value}T00:00`).getTime(); q.to = new Date(`${toEl.value}T00:00`).getTime(); }
    return q;
  };
  const label = (t, unit) => {
    const d = new Date(t);
    if (unit === 'hour') return `${String(d.getHours()).padStart(2, '0')}:00`;
    if (unit === 'month') return d.toLocaleDateString('fa-IR', { year: 'numeric', month: 'short' });
    return d.toLocaleDateString('fa-IR', { month: 'short', day: 'numeric' });
  };

  async function render() {
    let r;
    try { r = await window.aether.trafficQuery(query()); } catch { return; }
    const [nd, nu, td, tu] = r.total;
    const box = (title, d, u, wide) => el('div', { class: `tt${wide ? ' wide' : ''}` }, [el('small', {}, title), el('b', {}, fmtBytes(d + u)), el('small', { dir: 'ltr', style: 'display:block;text-align:right' }, `↓ ${fmtBytes(d)}   ↑ ${fmtBytes(u)}`)]);
    const totals = document.getElementById('traffic-totals');
    totals.innerHTML = '';
    totals.appendChild(box('اینترنت کامپیوتر (کارت شبکه)', nd, nu));
    totals.appendChild(box('داخل تونل (TUN / OpenVPN)', td, tu));
    // only hours where the tunnel was measured too, so proxy-mode hours do not inflate it
    const [pn, pt] = r.paired;
    if (pn > 0 && pt > 0) {
      const extra = Math.round((pn / pt - 1) * 100);
      totals.appendChild(el('div', { class: 'tt wide' }, [el('small', {}, 'سربار: اینترنت مصرفی نسبت به ترافیک داخل تونل (فقط ساعت‌هایی که هر دو اندازه گرفته شده)'), el('b', { dir: 'ltr', style: 'text-align:right' }, `${extra >= 0 ? '+' : ''}${extra}%`)]));
    }
    // bars: real network traffic, download stacked under upload
    const chart = document.getElementById('traffic-chart');
    chart.innerHTML = '';
    const max = Math.max(1, ...r.rows.map((x) => x.v[0] + x.v[1]));
    for (const row of r.rows) {
      const bar = el('div', { class: 'bar', title: `${label(row.start, r.unit)}  ↓ ${fmtBytes(row.v[0])}  ↑ ${fmtBytes(row.v[1])}` });
      bar.appendChild(el('i', { class: 'down', style: `height:${(row.v[0] / max) * 100}%` }));
      bar.appendChild(el('i', { class: 'up', style: `height:${(row.v[1] / max) * 100}%` }));
      chart.appendChild(bar);
    }
    const axis = chart.nextElementSibling && chart.nextElementSibling.classList.contains('traffic-axis') ? chart.nextElementSibling : chart.insertAdjacentElement('afterend', el('div', { class: 'traffic-axis' }));
    axis.innerHTML = '';
    if (r.rows.length) { axis.appendChild(el('span', {}, label(r.rows[0].start, r.unit))); axis.appendChild(el('span', {}, label(r.rows[r.rows.length - 1].start, r.unit))); }
    const eng = document.getElementById('traffic-engines');
    eng.innerHTML = '';
    const list = Object.entries(r.engines).sort((a, b) => (b[1][0] + b[1][1]) - (a[1][0] + a[1][1]));
    if (!list.length) eng.appendChild(el('p', { class: 'muted', style: 'font-size:12.5px' }, 'در این بازه هنوز چیزی ثبت نشده. آمار از نسخه‌ی 1.22.0 به بعد و فقط وقتی وصل هستید ثبت می‌شود.'));
    for (const [k, v] of list) eng.appendChild(el('div', { class: 'traffic-eng' }, [el('span', {}, ENGINE_NAMES[k] || k), el('span', {}, `↓ ${fmtBytes(v[0])}  ↑ ${fmtBytes(v[1])}`)]));
  }

  document.querySelectorAll('#traffic-views .engine-option').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.view;
    document.querySelectorAll('#traffic-views .engine-option').forEach((x) => x.classList.toggle('active', x === b));
    document.getElementById('traffic-range').hidden = view !== 'range';
    render();
  }));
  fromEl.addEventListener('change', render);
  toEl.addEventListener('change', render);
  document.getElementById('traffic-csv').addEventListener('click', () => window.aether.trafficExportCsv(query()));
  document.getElementById('traffic-reset').addEventListener('click', async () => {
    if (!(await uiConfirm('همه‌ی آمار مصرف داده پاک شود؟ این کار برگشت ندارد.', { danger: true, okText: 'پاک شود' }))) return;
    await window.aether.trafficReset();
    render();
  });
  // fresh numbers whenever the tab is opened, and every minute while it is open
  document.querySelector('[data-tab="traffic"]').addEventListener('click', render);
  setInterval(() => { if (document.getElementById('tab-traffic').classList.contains('active')) render(); }, 60000);
  render();
}

// ---------- Privacy / support the developer (home screen) ----------
// Paste the addresses here; an empty address shows "coming soon" and no copy button.
const WALLETS = [
  { coin: 'USDT (TRC20) / TRX', network: 'Tron', address: 'TXh8EGxoGRpdscTqZoAm2LuJHdgQRYZVfC' },
  { coin: 'SOL', network: 'Solana', address: 'BwbHCzTcPpznnfa6ST6JtsabmRvVYQDKgKACCyaGsnsR' },
  { coin: 'BTC', network: 'Bitcoin', address: 'bc1qtysesd8c0sm2sa4dykhc3l52p9thxn6j06etld' },
  { coin: 'ETH', network: 'Ethereum (ERC20)', address: '0xA84B654E5b22AaF2326a690f06AF4044d6e0a4b3' },
];

const PRIVACY_FA = `خلاصه: GozarVpn حساب کاربری و ثبت‌نام ندارد و هیچ آمار، تبلیغ یا ردیابی‌ای داخلش نیست. سازنده‌ی برنامه سروری ندارد و هیچ اطلاعاتی از شما، کانفیگ‌هایتان یا سایت‌هایی که باز می‌کنید به دستش نمی‌رسد.

چه چیزهایی روی کامپیوتر خودتان می‌ماند
• کانفیگ‌ها، ساب‌ها، پروفایل‌ها و تنظیمات فقط روی همین کامپیوتر ذخیره می‌شوند.
• نام کاربری و رمز OpenVPN با رمزنگاری خود ویندوز نگه داشته می‌شود.
• لاگ در حافظه است و ذخیره نمی‌شود، مگر خودتان کپی یا ذخیره‌اش کنید.
• آمار مصرف داده (حجم دانلود و آپلود در هر ساعت) فقط روی همین کامپیوتر ثبت می‌شود و جایی فرستاده نمی‌شود.

برنامه خودش به کجاها وصل می‌شود
• سرورهایی که خودتان انتخاب کرده‌اید و شبکه‌ی موتوری که روشن است (WARP کلودفلر، Tor، سایفون یا OpenVPN).
• تست پینگ و سالم بودن تونل: یک درخواست خیلی کوچک به گوگل یا کلودفلر، از داخل همان تونل.
• نشان دادن IP و کشور خروجی: صفحه‌ی trace کلودفلر، از داخل تونل.
• لینک سابی که خودتان اضافه کرده‌اید، برای گرفتن و به‌روز کردن کانفیگ‌ها.
• ساخت WARP رایگان: فقط وقتی دکمه‌اش را بزنید، یک اکانت WARP از کلودفلر گرفته می‌شود.
• دانلود هسته‌ها (Aether، sing-box، mihomo، Tor) از صفحه‌ی رسمی خودشان در GitHub یا سایت Tor، و نصب‌کننده‌ی OpenVPN از سایت OpenVPN، فقط وقتی خودتان دکمه‌اش را بزنید.
• پیدا کردن نسخه‌ی جدید: صفحه‌ی Releaseهای همین پروژه در GitHub. اگر نمی‌خواهید، «بررسی خودکار» را در بیشتر › به‌روزرسانی خاموش کنید.
• قوانین ایران (از jsDelivr) فقط وقتی دکمه‌ی به‌روزرسانی‌اش را بزنید.
در هیچ‌کدام از این درخواست‌ها چیزی درباره‌ی شما یا کانفیگ‌هایتان فرستاده نمی‌شود.

برنامه در ویندوز چه چیزهایی را تغییر می‌دهد
• پراکسی سیستم: هنگام اتصال تنظیم می‌شود و بعد از قطع به حالت قبل برمی‌گردد.
• دسترسی Administrator فقط برای حالت TUN، کیل‌سوییچ و OpenVPN لازم است.
• کیل‌سوییچ (اگر روشنش کنید) قوانین فایروال ویندوز را اضافه می‌کند و با قطع اتصال برمی‌دارد.
برنامه به فایل‌ها، دوربین، میکروفون یا برنامه‌های دیگر شما کاری ندارد.

کد برنامه
کد کامل GozarVpn با مجوز AGPL در github.com/falconf258/gozarVPN منتشر شده و هر کسی می‌تواند همه‌ی این‌ها را خودش بررسی کند.`;

const PRIVACY_EN = `In short: GozarVpn has no account and no sign-up, and contains no analytics, ads or tracking. The developer runs no server and receives nothing about you, your configs or the sites you visit.

What stays on your PC
• Your configs, subscriptions, profiles and settings are stored only on this PC.
• OpenVPN usernames and passwords are kept encrypted by Windows.
• The log lives in memory and is not saved unless you copy or save it.
• Data usage history (download and upload per hour) is kept only on this PC and never sent anywhere.

Where the app itself connects
• The servers you picked, and the network of the engine you turned on (Cloudflare WARP, Tor, Psiphon or OpenVPN).
• Ping and tunnel checks: one tiny request to Google or Cloudflare, through the tunnel.
• Showing your exit IP and country: Cloudflare's trace page, through the tunnel.
• Subscription links you added, to fetch and refresh their configs.
• Free WARP: only when you press its button, a WARP account is created at Cloudflare.
• Engine downloads (Aether, sing-box, mihomo, Tor) from their official GitHub or Tor pages, and the OpenVPN installer from openvpn.org, only when you press the button.
• New versions: this project's Releases page on GitHub. Turn off "check automatically" under More › Update if you don't want that.
• Iran rules (from jsDelivr) only when you press their update button.
None of these requests send anything about you or your configs.

What the app changes in Windows
• The system proxy: set while connected, put back as it was when you disconnect.
• Administrator rights are needed only for TUN mode, the kill switch and OpenVPN.
• The kill switch (if you turn it on) adds Windows Firewall rules and removes them when you disconnect.
The app does not touch your files, camera, microphone or other programs.

Source code
GozarVpn is open source (AGPL) at github.com/falconf258/gozarVPN, so anyone can check all of this.`;

function infoModal(title, body, extraButtons = []) {
  const overlay = el('div', { class: 'modal-overlay' });
  const close = el('button', { class: 'btn primary' }, 'بستن');
  overlay.appendChild(el('div', { class: 'modal-box', role: 'dialog' }, [el('h3', {}, title), body, el('div', { class: 'modal-actions' }, [close, ...extraButtons])]));
  const done = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') done(); };
  close.addEventListener('click', done);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) done(); });
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(overlay);
  close.focus();
}

function showPrivacy() {
  let english = false;
  const text = el('div', { class: 'info-text' }, PRIVACY_FA);
  const toggle = el('button', { class: 'btn ghost' }, 'English');
  toggle.addEventListener('click', () => {
    english = !english;
    text.textContent = english ? PRIVACY_EN : PRIVACY_FA;
    text.dir = english ? 'ltr' : 'rtl';
    toggle.textContent = english ? 'فارسی' : 'English';
  });
  infoModal('حریم خصوصی · Privacy', text, [toggle]);
}

function showDonate() {
  const rows = WALLETS.map((w) => {
    const head = el('div', { style: 'display:flex;align-items:center;gap:8px' }, [el('b', { style: 'flex:1' }, `${w.coin} · ${w.network}`)]);
    if (w.address) {
      const copy = el('button', { class: 'btn ghost small' }, 'کپی');
      copy.addEventListener('click', async () => { await navigator.clipboard.writeText(w.address); copy.textContent = 'کپی شد ✓'; setTimeout(() => { copy.textContent = 'کپی'; }, 1500); });
      head.appendChild(copy);
    }
    return el('div', { class: 'wallet-row' }, [head, w.address ? el('div', { class: 'wallet-addr' }, w.address) : el('div', { class: 'muted', style: 'font-size:12px' }, 'به‌زودی')]);
  });
  const body = el('div', { class: 'info-text' }, [
    el('p', { style: 'margin-top:0' }, 'اگر GozarVpn به کارتان آمده و دوست دارید حمایت کنید، می‌توانید به یکی از این آدرس‌ها رمزارز بفرستید. حمایت کاملاً اختیاری است و هیچ بخشی از برنامه به آن بستگی ندارد.'),
    el('p', {}, 'هر ارز را فقط روی شبکه‌ی همان ردیف بفرستید؛ مثلاً USDT فقط روی Tron (TRC20). ارسال روی شبکه‌ی اشتباه برگشت ندارد.'),
    ...rows,
    el('p', { class: 'muted', dir: 'ltr', style: 'font-size:11.5px' }, 'If GozarVpn helps you, you can support it with crypto. It is completely optional and changes nothing in the app.'),
  ]);
  infoModal('حمایت از سازنده', body);
}

// ---------- OpenVPN tab ----------
let refreshOpenvpnTab = async () => {};
async function wireOpenvpnTab() {
  const exeStatus = document.getElementById('openvpn-exe-status');
  const addStatus = document.getElementById('openvpn-add-status');
  const list = document.getElementById('openvpn-list');
  const progress = document.getElementById('openvpn-install-progress');

  refreshOpenvpnTab = async () => {
    const data = await window.aether.listOpenvpn();
    exeStatus.textContent = data.exe
      ? `✓ OpenVPN ${data.version || ''} پیدا شد: ${data.exe}`
      : '⚠ برنامه‌ی رسمی OpenVPN (Community) نصب نیست. «دانلود و نصب» فایل نصب رسمی را می‌گیرد، امضای OpenVPN Inc. را بررسی و نصب‌کننده را باز می‌کند (می‌توانید مسیر نصب را روی درایو دیگری بگذارید). اگر جای دیگری نصبش کرده‌اید، openvpn.exe را انتخاب کنید.';
    const installBtn = document.getElementById('openvpn-install');
    installBtn.textContent = {
      install: 'دانلود و نصب OpenVPN رسمی',
      installed: `نصب است ✓ (نسخه‌ی ${data.version || ''})`,
      update: `به‌روزرسانی به نسخه‌ی ${data.offered}`,
    }[data.installState];
    // nothing to download when the installed copy is already current
    installBtn.disabled = data.installState === 'installed';
    const active = data.profiles.find((p) => p.id === data.active);
    state.openvpnName = active ? active.name : '';
    refreshDashboardMeta();
    list.innerHTML = '';
    if (!data.profiles.length) list.appendChild(el('p', { class: 'muted' }, 'هنوز کانفیگی اضافه نشده.'));
    for (const p of data.profiles) {
      const isActive = p.id === data.active;
      const result = el('span', { class: 'test-result' }, p.test ? (p.test.ok ? `✓ ${p.test.latencyMs} ms` : `✗ ${p.test.error}`) : '');
      if (p.test) result.style.color = p.test.ok ? 'var(--ok, #4ade80)' : 'var(--bad, #f87171)';
      const notes = [];
      if (p.needsAuth) notes.push(p.hasCreds ? '🔑 نام کاربری ذخیره شده' : '🔑 نام کاربری و رمز لازم است');
      if (p.removed.length) notes.push(`حذف‌شده برای امنیت: ${p.removed.join(', ')}`);
      if (p.problems.length) notes.push(`⚠ ${p.problems.join('؛ ')}`);
      list.appendChild(el('div', {
        class: `v2ray-row${isActive ? ' active' : ''}`,
        onclick: async () => {
          try { await window.aether.setActiveOpenvpn(p.id); await refreshOpenvpnTab(); renderEngineOptions(); }
          catch (err) { addStatus.textContent = `خطا: ${err.message || err}`; }
        }
      }, [
        el('div', { class: 'row-top' }, [
          el('span', { class: 'badge proto-openvpn' }, 'OVPN'),
          el('span', { class: 'name', title: p.name }, p.name),
          isActive ? el('span', { class: 'active-tag' }, '✓ فعال') : null
        ]),
        el('div', { class: 'muted', style: 'font-size:11.5px;direction:ltr;text-align:right' }, p.server + (p.servers > 1 ? ` (+${p.servers - 1})` : '')),
        notes.length ? el('div', { class: 'muted', style: 'font-size:11.5px' }, notes.join(' · ')) : null,
        el('div', { class: 'row-actions' }, [
          result,
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'btn ghost small',
            onclick: async (e) => {
              e.stopPropagation();
              e.target.disabled = true;
              result.textContent = 'در حال تست…';
              result.style.color = '';
              try { await window.aether.testOpenvpn(p.id); } catch (err) { addStatus.textContent = `خطا: ${err.message || err}`; }
              await refreshOpenvpnTab();
            }
          }, 'تست'),
          p.needsAuth ? el('button', {
            class: 'btn ghost small',
            onclick: async (e) => {
              e.stopPropagation();
              const user = await uiDialog({ message: `نام کاربری «${p.name}» (خالی = پاک کردن)`, okText: 'ادامه', cancelText: 'انصراف', input: { placeholder: 'username' } });
              if (user === null) return;
              const pass = user ? await uiDialog({ message: 'رمز عبور', okText: 'ذخیره', cancelText: 'انصراف', input: { placeholder: 'password', type: 'password' } }) : '';
              if (pass === null) return;
              try { await window.aether.setOpenvpnCreds(p.id, user.trim(), pass); addStatus.textContent = user ? 'نام کاربری و رمز (رمزنگاری‌شده) ذخیره شد.' : 'نام کاربری و رمز پاک شد.'; }
              catch (err) { addStatus.textContent = `خطا: ${err.message || err}`; }
              await refreshOpenvpnTab();
            }
          }, '🔑 کاربر') : null,
          el('button', {
            class: 'btn ghost small',
            onclick: async (e) => {
              e.stopPropagation();
              const name = await uiPrompt('نام جدید', p.name);
              if (name) { await window.aether.renameOpenvpn(p.id, name); await refreshOpenvpnTab(); }
            }
          }, 'نام'),
          el('button', {
            class: 'btn ghost small danger',
            onclick: async (e) => {
              e.stopPropagation();
              if (!(await uiConfirm(`کانفیگ «${p.name}» حذف شود؟`))) return;
              await window.aether.deleteOpenvpn(p.id);
              await refreshOpenvpnTab();
              renderEngineOptions();
            }
          }, 'حذف')
        ])
      ]));
    }
  };

  const afterAdd = async (added, errors) => {
    const parts = [];
    if (added.length) parts.push(`${added.length} کانفیگ اضافه شد${added.some((a) => a.needsAuth && !a.hasCreds) ? ' (برای بعضی نام کاربری و رمز را با دکمه‌ی 🔑 وارد کنید)' : ''}.`);
    if (errors.length) parts.push(`خطا: ${errors.join(' | ')}`);
    addStatus.textContent = parts.join(' ');
    await refreshOpenvpnTab();
    renderEngineOptions();
  };
  document.getElementById('openvpn-add-file').addEventListener('click', async () => {
    try { const r = await window.aether.importOpenvpnFiles(); await afterAdd(r.added, r.errors); }
    catch (err) { addStatus.textContent = `خطا: ${err.message || err}`; }
  });
  document.getElementById('openvpn-add-clip').addEventListener('click', async () => {
    try { await afterAdd([await window.aether.importOpenvpnClipboard()], []); }
    catch (err) { addStatus.textContent = `خطا: ${err.message || err}`; }
  });
  document.getElementById('openvpn-pick').addEventListener('click', async () => {
    try { if (await window.aether.pickOpenvpnExe()) await refreshOpenvpnTab(); }
    catch (err) { exeStatus.textContent = `خطا: ${err.message || err}`; }
  });
  document.getElementById('openvpn-install').addEventListener('click', async (e) => {
    e.target.disabled = true;
    progress.classList.add('active');
    try {
      const r = await window.aether.installOpenvpn();
      if (r && r.already) {
        exeStatus.textContent = `OpenVPN از قبل نصب است (نسخه‌ی ${r.version}) و همان استفاده می‌شود: ${r.exe}`;
      } else {
        exeStatus.textContent = 'نصب‌کننده‌ی رسمی (امضاشده توسط OpenVPN Inc.) باز شد. نصب را تمام کنید؛ این صفحه خودش متوجه می‌شود.';
        // notice when the setup wizard has finished (checked every 5 s for 15 minutes)
        const before = (await window.aether.listOpenvpn()).version;
        for (let i = 0; i < 180; i++) {
          await new Promise((res) => setTimeout(res, 5000));
          const now = await window.aether.listOpenvpn();
          if (now.exe && now.version !== before) { exeStatus.textContent = `✓ OpenVPN ${now.version} نصب شد.`; break; }
        }
      }
    } catch (err) {
      exeStatus.textContent = `خطا: ${err.message || err}`;
    } finally {
      progress.classList.remove('active');
      await refreshOpenvpnTab();
    }
  });
  window.aether.onOpenvpnInstallProgress((p) => {
    document.getElementById('openvpn-install-progress-bar').style.width = `${Math.round((p.pct || 0) * 100)}%`;
    if (p.stage === 'install') exeStatus.textContent = 'امضای فایل تأیید شد؛ در حال باز کردن نصب‌کننده…';
  });
  // re-check after the installer may have finished
  document.querySelector('[data-tab="openvpn"]').addEventListener('click', () => refreshOpenvpnTab());
  await refreshOpenvpnTab();
}

// ---------- Psiphon tab ----------
async function wirePsiphonTab() {
  const info = await window.aether.getPsiphonInfo();
  const route = document.getElementById('psiphon-route');
  const mode = document.getElementById('psiphon-mode');
  const region = document.getElementById('psiphon-region');
  route.value = info.route; mode.value = info.mode; region.value = info.region;
  state.psiphonRoute = info.route;
  const status = document.getElementById('psiphon-core-status');
  status.textContent = info.coreSupports
    ? `✓ هسته‌ی Aether نصب‌شده (${info.coreVersion || 'همراه برنامه'}) از سایفون پشتیبانی می‌کند.`
    : '⚠ هسته‌ی Aether نصب‌شده از سایفون پشتیبانی نمی‌کند. از «بیشتر › به‌روزرسانی»، هسته‌ی Aether را به‌روز کنید (نسخه‌ی 2.4.0 یا جدیدتر).';
  const save = async () => {
    await window.aether.setPsiphon({ route: route.value, mode: mode.value, region: region.value });
    state.psiphonRoute = route.value;
    refreshDashboardMeta();
  };
  for (const s of [route, mode, region]) s.addEventListener('change', save);

  const dpi = document.getElementById('v2ray-dpi-smart');
  dpi.checked = !!(await window.aether.getProfiles()).ui.dpiSmart;
  dpi.addEventListener('change', () => window.aether.setUiPrefs({ dpiSmart: dpi.checked }));
}

async function init() {  state.schema = await window.aether.getEnvSchema();
  await populateProfiles();
  renderForms();
  renderPresets();
  refreshDashboardMeta();

  wireNav();
  wireTunMode();
  wireConnectButtons();
  wireProfiles();
  wireSettingsTab();
  wireLogsTab();
  await wireUpdateTab();
  await wireScannerTab();
  await wireEngineSelector();
  refreshDashboardMeta();
  await wireV2rayTab();
  await wireMihomoTab();
  await wireTorTab();
  await wirePsiphonTab();
  await wireOpenvpnTab();
  await wireTrafficTab();
  document.getElementById('open-privacy').addEventListener('click', showPrivacy);
  document.getElementById('open-donate').addEventListener('click', showDonate);
  await wireRoutingCard();
  await wireCustomBridges();
  wireLiveStats();
  window.aether.getAppVersion().then((v) => {
    const el = document.getElementById('about-version');
    if (el) el.textContent = v;
  });

  window.aether.onCoreStatus((s) => { setStatusUi(s); paintQuickActions(s); refreshKillSwitch(); });
  window.aether.onCoreLog(appendLogLine);
  window.aether.onCoreLogBatch(appendLogLines);
  window.aether.onTunnelVerify(setTunnelBanner);

  const initialState = await window.aether.getCoreState();
  setStatusUi(initialState);
  paintQuickActions(initialState);
  const existingLogs = await window.aether.getCoreLogs();
  existingLogs.forEach(appendLogLine);
}

init();
