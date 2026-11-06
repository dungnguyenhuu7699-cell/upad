/* Kế Hoạch — offline-first.
 * - Dữ liệu luôn lưu trong máy (localStorage) → mở app lúc không mạng vẫn dùng bình thường.
 * - Khi có mạng: kéo dữ liệu từ Firestore, GỘP (merge) với dữ liệu trên máy, rồi đẩy bản gộp lên.
 * - Không dùng thư viện ngoài (không CDN) nên không bị "trắng trang" khi offline.
 */
(() => {
'use strict';

/* ================= Cấu hình Firebase (giữ nguyên project của bạn) ================= */
const FIREBASE = { apiKey: 'AIzaSyDveyNHxv1fnu7c5-eLtvONnaToBoNkK2k', projectId: 'todolist-366ca' };
const DOC_PATH = 'todo_app/my_shared_tasks';
const DOC_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents/${DOC_PATH}`;

const STORAGE_KEY = 'todo_habit_db_v1';      // giữ key cũ → không mất dữ liệu đang có
const META_KEY = 'todo_habit_meta_v1';
const TIMERS_KEY = 'todo_habit_timers_v1';
const TOMBSTONE_TTL = 60 * 86400 * 1000;      // xoá hẳn dấu vết "đã xoá" sau 60 ngày
const COMPACT_AFTER_DAYS = 45;

/* ================= Tiện ích ================= */
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => dateStr(new Date());
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* bộ nhớ đầy / chế độ riêng tư */ } };
const readJSON = (k, fb) => { try { const v = JSON.parse(lsGet(k)); return v ?? fb; } catch (e) { return fb; } };

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const canonical = (tasks) => stable([...tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

/* ================= Mô hình dữ liệu + GỘP ================= */
function normalizeTask(t) {
  if (!t || t.id == null) return null;
  const n = {
    id: String(t.id),
    title: String(t.title ?? ''),
    startTime: String(t.startTime ?? ''),
    duration: Number(t.duration) || 0,
    note: String(t.note ?? ''),
    daysOfWeek: Array.isArray(t.daysOfWeek) ? t.daysOfWeek.map(Number).filter((d) => d >= 0 && d <= 6) : [],
    completions: {},
    completionsAt: {},
    updatedAt: Number(t.updatedAt) || 0,
  };
  if (t.deleted) n.deleted = true;
  if (t.completions && typeof t.completions === 'object') for (const k of Object.keys(t.completions)) n.completions[k] = !!t.completions[k];
  if (t.completionsAt && typeof t.completionsAt === 'object') for (const k of Object.keys(t.completionsAt)) n.completionsAt[k] = Number(t.completionsAt[k]) || 0;
  return n;
}

function compactTask(t) {
  const limit = dateStr(new Date(Date.now() - COMPACT_AFTER_DAYS * 86400000));
  for (const k of Object.keys(t.completions)) {
    if (k < limit) { delete t.completionsAt[k]; if (!t.completions[k]) delete t.completions[k]; }
  }
  return t;
}

function mergeTask(a, b) {
  let win;
  if (a.updatedAt !== b.updatedAt) win = a.updatedAt > b.updatedAt ? a : b;
  else win = stable(a) >= stable(b) ? a : b;       // hoà → chọn ổn định, không phụ thuộc máy nào
  const out = { ...win, completions: {}, completionsAt: {}, updatedAt: Math.max(a.updatedAt, b.updatedAt) };
  if (win.deleted) out.deleted = true; else delete out.deleted;
  out.updatedAt = win.updatedAt;
  if (win.deleted) return out;                       // đã xoá → không giữ lịch sử tick
  const keys = new Set([...Object.keys(a.completions), ...Object.keys(b.completions)]);
  for (const k of keys) {
    const inA = k in a.completions, inB = k in b.completions;
    const ta = a.completionsAt[k] || 0, tb = b.completionsAt[k] || 0;
    let v, t;
    if (inA && !inB) { v = a.completions[k]; t = ta; }
    else if (inB && !inA) { v = b.completions[k]; t = tb; }
    else if (ta !== tb) { const w = ta > tb ? a : b; v = w.completions[k]; t = Math.max(ta, tb); }
    else { v = a.completions[k] || b.completions[k]; t = ta; }
    out.completions[k] = v;
    if (t) out.completionsAt[k] = t;
  }
  return compactTask(out);
}

function mergeLists(listA, listB) {
  const map = new Map();
  const cutoff = Date.now() - TOMBSTONE_TTL;
  for (const raw of [...listA, ...listB]) {
    const t = normalizeTask(raw);
    if (!t) continue;
    const cur = map.get(t.id);
    map.set(t.id, cur ? mergeTask(cur, t) : compactTask(t));
  }
  return [...map.values()].filter((t) => !(t.deleted && t.updatedAt < cutoff));
}

/* ================= Trạng thái ================= */
const state = {
  tasks: [],
  month: new Date().getMonth(),
  year: new Date().getFullYear(),
  tab: 'today',
};
let meta = readJSON(META_KEY, { pending: false, lastSync: 0 });
let localVersion = 0;
let selectedDays = [1, 2, 3, 4, 5];
const notified = {};

(function loadLocal() {
  const d = readJSON(STORAGE_KEY, null);
  if (d && Array.isArray(d.tasks)) state.tasks = d.tasks.map(normalizeTask).filter(Boolean);
})();

const visible = () => state.tasks.filter((t) => !t.deleted);
const byTime = (a, b) => ((a.startTime || '99:99') + a.id).localeCompare((b.startTime || '99:99') + b.id);
const saveLocal = () => lsSet(STORAGE_KEY, JSON.stringify({ tasks: state.tasks }));
const saveMeta = () => lsSet(META_KEY, JSON.stringify(meta));

function commit() {                       // gọi sau MỌI thay đổi của người dùng
  localVersion++;
  meta.pending = true;
  saveLocal(); saveMeta();
  render();
  setSyncUI();
  scheduleSync(600);
  rescheduleNative();
}

/* ================= Đồng bộ Firestore (REST) ================= */
const toFs = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: v.length ? { values: v.map(toFs) } : {} };
  const fields = {};
  for (const k of Object.keys(v)) if (v[k] !== undefined) fields[k] = toFs(v[k]);
  return { mapValue: { fields } };
};
const fromFs = (v) => {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFs);
  if ('mapValue' in v) { const o = {}; const f = v.mapValue.fields || {}; for (const k of Object.keys(f)) o[k] = fromFs(f[k]); return o; }
  return null;
};

class SyncError extends Error { constructor(kind, msg) { super(msg || kind); this.kind = kind; } }

async function fsFetch(method, query, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    return await fetch(`${DOC_URL}?key=${FIREBASE.apiKey}${query}`, {
      method, cache: 'no-store', signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new SyncError('network', e.message);
  } finally { clearTimeout(timer); }
}

async function pull() {
  const res = await fsFetch('GET', '');
  if (res.status === 404) return { tasks: [], updateTime: null };
  if (res.status === 401 || res.status === 403) throw new SyncError('perm');
  if (!res.ok) throw new SyncError('http', 'HTTP ' + res.status);
  const json = await res.json();
  const arr = fromFs(json.fields && json.fields.tasks) || [];
  return { tasks: arr.map(normalizeTask).filter(Boolean), updateTime: json.updateTime || null };
}

async function push(tasks, updateTime) {
  const precond = updateTime ? `&currentDocument.updateTime=${encodeURIComponent(updateTime)}` : '&currentDocument.exists=false';
  const body = { fields: { tasks: toFs(JSON.parse(JSON.stringify(tasks))) } };
  const res = await fsFetch('PATCH', `&updateMask.fieldPaths=tasks${precond}`, body);
  if (res.ok) return true;
  if (res.status === 401 || res.status === 403) throw new SyncError('perm');
  if (res.status === 409 || res.status === 412 || res.status === 400) {
    let txt = ''; try { txt = await res.text(); } catch (e) {}
    if (res.status !== 400 || /FAILED_PRECONDITION|ABORTED|ALREADY_EXISTS/.test(txt)) return false;   // có máy khác vừa ghi → gộp lại
    throw new SyncError('http', 'HTTP 400');
  }
  throw new SyncError('http', 'HTTP ' + res.status);
}

let syncing = false, syncAgain = false, syncTimer = null, syncStatus = 'idle', syncErr = '';

function scheduleSync(delay = 0) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, delay); }

async function syncNow() {
  if (syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { syncStatus = 'offline'; setSyncUI(); return; }
  syncing = true; syncStatus = 'syncing'; setSyncUI();
  const startVersion = localVersion;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const remote = await pull();
      const merged = mergeLists(state.tasks, remote.tasks);
      if (canonical(merged) !== canonical(state.tasks)) { state.tasks = merged; saveLocal(); render(); rescheduleNative(); }
      if (canonical(merged) === canonical(remote.tasks)) break;          // hai bên đã giống nhau
      if (await push(merged, remote.updateTime)) break;                  // đẩy thành công
      // thất bại do xung đột → vòng sau kéo lại, gộp lại, đẩy lại
    }
    if (localVersion === startVersion) meta.pending = false;
    meta.lastSync = Date.now(); saveMeta();
    syncStatus = 'synced'; syncErr = '';
  } catch (e) {
    syncStatus = e.kind === 'perm' ? 'perm' : (navigator.onLine ? 'error' : 'offline');
    syncErr = e.message || '';
  } finally {
    syncing = false;
    setSyncUI();
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
}

function setSyncUI() {
  const badge = $('sync-badge'), text = $('sync-text'), banner = $('sync-banner');
  let kind = syncStatus, label;
  if (!navigator.onLine) kind = 'offline';
  if (kind === 'offline') label = meta.pending ? 'Ngoại tuyến · chờ đẩy lên' : 'Ngoại tuyến';
  else if (kind === 'syncing') label = 'Đang đồng bộ…';
  else if (kind === 'perm') label = 'Lỗi quyền Firebase';
  else if (kind === 'error') label = meta.pending ? 'Lỗi mạng · chờ đẩy lên' : 'Lỗi mạng';
  else if (kind === 'synced') label = meta.pending ? 'Chờ đồng bộ' : 'Đã đồng bộ';
  else label = 'Trực tuyến';
  badge.className = 'badge ' + (kind === 'idle' ? 'synced' : kind);
  text.textContent = label;
  badge.title = meta.lastSync ? 'Đồng bộ lần cuối: ' + new Date(meta.lastSync).toLocaleString('vi-VN') : 'Bấm để đồng bộ ngay';
  if (kind === 'perm') {
    banner.textContent = 'Firebase đang từ chối truy cập (Rules đã hết hạn hoặc chưa mở). Dữ liệu vẫn được lưu an toàn trên máy này và sẽ tự đẩy lên khi sửa xong Rules.';
    banner.classList.remove('hidden');
  } else banner.classList.add('hidden');
}

window.addEventListener('online', () => { setSyncUI(); scheduleSync(300); });
window.addEventListener('offline', () => { syncStatus = 'offline'; setSyncUI(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkDayChange(); scheduleSync(200); } });
window.addEventListener('focus', () => scheduleSync(300));
setInterval(() => { if (!document.hidden) syncNow(); }, 20000);   // nhận thay đổi từ máy khác

/* ================= Bản Android (Capacitor): báo thức thật kể cả khi đã đóng app ================= */
const CAP = window.Capacitor;
const NATIVE = !!(CAP && typeof CAP.isNativePlatform === 'function' && CAP.isNativePlatform());
const LN = NATIVE ? CAP.Plugins.LocalNotifications : null;
const nid = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return (Math.abs(h) % 2147483000) + 1; };
let nativeReady = null, nativeTimer = null, exactAsked = false;

function nativeSetup() {
  if (!LN) return Promise.resolve(false);
  if (nativeReady) return nativeReady;
  nativeReady = (async () => {
    try {
      let perm = await LN.checkPermissions();
      if (perm.display !== 'granted') perm = await LN.requestPermissions();
      if (perm.display !== 'granted') { toast('Hãy cho phép thông báo cho Kế Hoạch trong Cài đặt điện thoại.'); return false; }
      await LN.createChannel({ id: 'reminders', name: 'Nhắc nhở công việc', description: 'Báo giờ bắt đầu và hết giờ đếm ngược', importance: 5, visibility: 1, vibration: true, lights: true });
      try {
        const ex = await LN.checkExactNotificationSetting();
        if (ex.exact_alarm === 'denied' && !exactAsked) {
          exactAsked = true;
          if (window.confirm('Để báo đúng giờ khi đã đóng app, hãy bật quyền "Báo thức & lời nhắc" cho Kế Hoạch. Mở cài đặt ngay?')) await LN.changeExactNotificationSetting();
        }
      } catch (e) { /* Android cũ không cần */ }
      return true;
    } catch (e) { console.warn('Native setup', e); nativeReady = null; return false; }
  })();
  return nativeReady;
}

function rescheduleNative(delay = 800) {
  if (!LN) return;
  clearTimeout(nativeTimer);
  nativeTimer = setTimeout(async () => {
    if (!(await nativeSetup())) return;
    try {
      const pend = await LN.getPending();
      const old = (pend.notifications || []).filter((n) => !(n.extra && n.extra.kind === 'timer'));
      if (old.length) await LN.cancel({ notifications: old.map((n) => ({ id: n.id })) });
      const list = [];
      visible().forEach((t) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(t.startTime || ''); if (!m) return;
        t.daysOfWeek.forEach((d) => list.push({
          id: nid(t.id + '_' + d),
          title: `🔔 Đến giờ: ${t.title}`,
          body: t.duration ? `Thời lượng: ${t.duration} phút. Mở app để bắt đầu đếm giờ!` : 'Đã đến giờ bắt đầu công việc!',
          channelId: 'reminders',
          extra: { kind: 'task' },
          schedule: { on: { weekday: d + 1, hour: +m[1], minute: +m[2] }, allowWhileIdle: true },   // lặp hằng tuần (CN = 1)
        }));
      });
      if (list.length) await LN.schedule({ notifications: list });
    } catch (e) { console.warn('Native schedule', e); }
  }, delay);
}

async function scheduleTimerNative(id, endAt, task) {
  if (!LN || !(await nativeSetup())) return;
  try {
    await LN.schedule({ notifications: [{
      id: nid('timer_' + id), title: 'Hết giờ!', body: `Đã hoàn thành ${task.duration} phút cho "${task.title}".`,
      channelId: 'reminders', extra: { kind: 'timer' }, schedule: { at: new Date(endAt), allowWhileIdle: true },
    }] });
  } catch (e) { console.warn('Native timer', e); }
}
function cancelTimerNative(id) { if (LN) LN.cancel({ notifications: [{ id: nid('timer_' + id) }] }).catch(() => {}); }

/* ================= Âm thanh / thông báo ================= */
function playChimeSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination); osc.type = 'triangle';
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(523.25, t); osc.frequency.setValueAtTime(659.25, t + .15);
    osc.frequency.setValueAtTime(783.99, t + .3); osc.frequency.setValueAtTime(1046.5, t + .45);
    gain.gain.setValueAtTime(.4, t); gain.gain.exponentialRampToValueAtTime(.001, t + 1.2);
    osc.start(); osc.stop(t + 1.2);
    setTimeout(() => ctx.close && ctx.close(), 1500);
  } catch (e) {}
}

function updateBellButton() {
  const btn = $('btn-sound-test');
  if (NATIVE) return;
  if ('Notification' in window && Notification.permission === 'granted') { btn.textContent = '🔔 Đã bật'; btn.classList.add('on'); }
}

function requestNotificationAndSound() {
  if (LN) {
    nativeSetup().then(async (ok) => {
      if (!ok) return;
      rescheduleNative(0);
      await LN.schedule({ notifications: [{ id: 1, title: 'Kế Hoạch', body: 'Báo thức đã sẵn sàng! Thông báo sẽ hiện cả khi đã đóng app.', channelId: 'reminders', schedule: { at: new Date(Date.now() + 2000), allowWhileIdle: true } }] });
      $('btn-sound-test').textContent = '🔔 Đã bật'; $('btn-sound-test').classList.add('on');
      toast('Sẽ có thông báo thử sau 2 giây.');
    });
    return;
  }
  playChimeSound();
  if (!('Notification' in window)) { toast('Thiết bị này không hỗ trợ thông báo.'); return; }
  Notification.requestPermission().then((p) => {
    updateBellButton();
    if (p === 'granted') sendAppNotification('Kế Hoạch', 'Hệ thống chuông hẹn giờ đã sẵn sàng!');
    else toast('Bạn chưa cho phép thông báo trong cài đặt trình duyệt.');
  });
}

function sendAppNotification(title, message) {
  playChimeSound();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const fallback = () => { try { new Notification(title, { body: message }); } catch (e) {} };
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, { body: message, icon: 'icon-192.png', badge: 'icon-192.png', vibrate: [200, 100, 200] })).catch(fallback);
  } else fallback();
}

setInterval(() => {
  if (NATIVE) return;                       // bản Android đã có báo thức hệ thống
  const d = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`, dow = d.getDay(), ds = dateStr(d);
  visible().forEach((t) => {
    if (t.startTime && t.daysOfWeek.includes(dow) && !t.completions[ds] && t.startTime === hm) {
      const key = `${t.id}_${ds}_${t.startTime}`;
      if (notified[key]) return;
      notified[key] = true;
      sendAppNotification(`🔔 Đến giờ: ${t.title}`, t.duration ? `Thời lượng: ${t.duration} phút. Mở app để bắt đầu đếm giờ!` : 'Đã đến giờ bắt đầu công việc!');
    }
  });
}, 10000);

/* ================= Đếm ngược (tính theo mốc thời gian nên không bị lệch khi nền) ================= */
let timers = readJSON(TIMERS_KEY, {});
const saveTimers = () => lsSet(TIMERS_KEY, JSON.stringify(timers));
const formatTime = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;

function timerRemaining(id, t) {
  const tm = timers[id];
  if (tm) return tm.running ? Math.max(0, Math.ceil((tm.endAt - Date.now()) / 1000)) : tm.remaining;
  return t && t.duration ? t.duration * 60 : 0;
}
function startTimer(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t || !t.duration) return;
  playChimeSound();
  const rem = timers[id] ? timers[id].remaining : t.duration * 60;
  timers[id] = { running: true, remaining: rem, endAt: Date.now() + rem * 1000 };
  saveTimers(); render();
  scheduleTimerNative(id, timers[id].endAt, t);
}
function pauseTimer(id) {
  const tm = timers[id]; if (!tm) return;
  tm.remaining = timerRemaining(id); tm.running = false; saveTimers(); render();
  cancelTimerNative(id);
}
function dropTimer(id) { delete timers[id]; saveTimers(); cancelTimerNative(id); }
function resetTimer(id) { dropTimer(id); render(); }
function finishTimer(id) {
  const t = state.tasks.find((x) => x.id === id);
  delete timers[id]; saveTimers();       // thông báo hệ thống (nếu có) đã tự nổ
  if (!t) return render();
  if (!NATIVE) sendAppNotification('Hết giờ!', `Đã hoàn thành ${t.duration} phút cho "${t.title}".`);
  render();
  setTimeout(() => { if (window.confirm(`Đã hết giờ cho "${t.title}"! Hoàn thành luôn không?`)) setDone(id, todayStr(), true); }, 300);
}
setInterval(() => {
  for (const id of Object.keys(timers)) {
    const tm = timers[id];
    if (!tm.running) continue;
    const rem = timerRemaining(id);
    const el = $('timer-val-' + id);
    if (el) el.textContent = formatTime(rem);
    if (rem <= 0) finishTimer(id);
  }
}, 1000);

/* ================= Thao tác dữ liệu ================= */
function setDone(id, ds, value) {
  const t = state.tasks.find((x) => x.id === id); if (!t) return;
  const v = value === undefined ? !t.completions[ds] : value;
  t.completions[ds] = v; t.completionsAt[ds] = Date.now();     // chỉ gắn dấu thời gian cho ngày này → không đè sửa đổi khác
  commit();
}

function saveTask() {
  const title = $('task-title-input').value.trim();
  if (!title) { $('task-title-input').focus(); return; }
  const startTime = $('task-start-time').value;
  const duration = parseInt($('task-duration-input').value, 10) || 0;
  const note = $('task-note-input').value.trim();
  const editingId = $('editing-task-id').value;
  const now = Date.now();
  if (editingId) {
    const t = state.tasks.find((x) => x.id === editingId);
    if (t) { Object.assign(t, { title, startTime, duration, note, daysOfWeek: [...selectedDays], updatedAt: now }); delete t.deleted; }
    dropTimer(editingId);
  } else {
    state.tasks.push({ id: String(now), title, startTime, duration, note, daysOfWeek: [...selectedDays], completions: {}, completionsAt: {}, updatedAt: now });
  }
  commit(); closeModal();
}

function deleteTask(id) {
  const t = state.tasks.find((x) => x.id === id); if (!t) return;
  if (!window.confirm(`Xoá "${t.title}"?`)) return;
  Object.assign(t, { deleted: true, updatedAt: Date.now(), title: '', note: '', startTime: '', duration: 0, daysOfWeek: [], completions: {}, completionsAt: {} });
  dropTimer(id);
  commit();
}

/* ================= Giao diện ================= */
function refreshDayButtons() {
  document.querySelectorAll('.day-btn').forEach((b) => b.classList.toggle('on', selectedDays.includes(parseInt(b.dataset.day, 10))));
}
function openModal(task) {
  $('modal-heading').textContent = task ? 'Chỉnh sửa kế hoạch' : 'Thêm kế hoạch mới';
  $('editing-task-id').value = task ? task.id : '';
  $('task-title-input').value = task ? task.title : '';
  $('task-start-time').value = task ? task.startTime : '';
  $('task-duration-input').value = task ? (task.duration || '') : '30';
  $('task-note-input').value = task ? task.note : '';
  selectedDays = task ? [...task.daysOfWeek] : [1, 2, 3, 4, 5];
  refreshDayButtons();
  $('modal-backdrop').classList.remove('hidden');
  setTimeout(() => $('task-title-input').focus(), 50);
}
function closeModal() { $('modal-backdrop').classList.add('hidden'); }

function switchView(tab) {
  state.tab = tab;
  $('tab-today-btn').classList.toggle('active', tab === 'today');
  $('tab-month-btn').classList.toggle('active', tab === 'month');
  $('view-today').classList.toggle('hidden', tab !== 'today');
  $('view-month').classList.toggle('hidden', tab !== 'month');
  $('month-nav').classList.toggle('show', tab === 'month');
  render();
}
function changeMonth(delta) {
  state.month += delta;
  if (state.month < 0) { state.month = 11; state.year--; }
  else if (state.month > 11) { state.month = 0; state.year++; }
  render();
}

let toastTimer;
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

const SVG_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
const SVG_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
const SVG_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const SVG_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
const DAY_NAMES = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

function render() {
  const now = new Date(), ts = dateStr(now), dow = now.getDay();
  const tasks = visible().sort(byTime);
  $('current-date-text').textContent = `${DAY_NAMES[dow]}, ${now.getDate()} thg ${now.getMonth() + 1}, ${now.getFullYear()}`;
  $('month-title').textContent = `Tháng ${state.month + 1}/${state.year}`;
  const daysInMonth = new Date(state.year, state.month + 1, 0).getDate();
  const todayTasks = tasks.filter((t) => t.daysOfWeek.includes(dow));

  let pct, c1, c2, l1, l2, title;
  if (state.tab === 'today') {
    const done = todayTasks.filter((t) => t.completions[ts]).length;
    pct = todayTasks.length ? Math.round(done / todayTasks.length * 100) : 0;
    title = 'Tiến độ hôm nay'; l1 = 'Việc hôm nay'; l2 = 'Đã hoàn thành'; c1 = todayTasks.length; c2 = done;
  } else {
    let due = 0, done = 0;
    tasks.forEach((t) => {
      for (let d = 1; d <= daysInMonth; d++) {
        if (t.daysOfWeek.includes(new Date(state.year, state.month, d).getDay())) {
          due++; if (t.completions[`${state.year}-${pad(state.month + 1)}-${pad(d)}`]) done++;
        }
      }
    });
    pct = due ? Math.round(done / due * 100) : 0;
    title = 'Tiến độ tháng này'; l1 = 'Tổng nhiệm vụ'; l2 = 'Lượt hoàn thành'; c1 = tasks.length; c2 = done;
  }
  $('progress-title').textContent = title; $('stat-col1-label').textContent = l1; $('stat-col2-label').textContent = l2;
  $('stat-percent').textContent = pct + '%'; $('stat-progress-bar').style.width = pct + '%';
  $('stat-col1-val').textContent = c1; $('stat-col2-val').textContent = c2;

  /* Hôm nay */
  $('today-tasks-container').innerHTML = todayTasks.length ? todayTasks.map((t) => {
    const done = !!t.completions[ts], tm = timers[t.id], running = !!(tm && tm.running);
    const timerHTML = t.duration ? `
      <div class="timer">
        <div class="timer-val"><span>⏱️</span><span id="timer-val-${esc(t.id)}">${formatTime(timerRemaining(t.id, t))}</span><small>/ ${t.duration} phút</small></div>
        <div class="timer-btns">
          ${running ? `<button class="tbtn pause" data-act="pause" data-id="${esc(t.id)}">Tạm dừng</button>` : `<button class="tbtn go" data-act="start" data-id="${esc(t.id)}">Bắt đầu</button>`}
          <button class="tbtn" data-act="reset" data-id="${esc(t.id)}">Đặt lại</button>
        </div>
      </div>` : '';
    return `
      <div class="task ${running ? 'running' : ''}">
        <div class="task-row">
          <div class="task-main">
            <button class="check ${done ? 'on' : ''}" data-act="toggle" data-id="${esc(t.id)}" data-date="${ts}" aria-label="Hoàn thành">${done ? SVG_CHECK : ''}</button>
            <span class="task-title ${done ? 'done' : ''}">${esc(t.title)}</span>
          </div>
          <div class="task-side">
            ${t.startTime ? `<span class="time-chip">${SVG_CLOCK}${esc(t.startTime)}</span>` : ''}
            <button class="icon-btn" data-act="edit" data-id="${esc(t.id)}" aria-label="Sửa">${SVG_EDIT}</button>
            <button class="icon-btn danger" data-act="delete" data-id="${esc(t.id)}" aria-label="Xoá">${SVG_TRASH}</button>
          </div>
        </div>
        ${timerHTML}
        ${t.note ? `<div class="note">${esc(t.note)}</div>` : ''}
      </div>`;
  }).join('') : '<div class="empty">Hôm nay không có kế hoạch nào.</div>';

  /* Lịch tháng */
  let h = '<th class="sticky-col">Kế hoạch</th>';
  for (let d = 1; d <= daysInMonth; d++) {
    const cur = d === now.getDate() && state.month === now.getMonth() && state.year === now.getFullYear();
    h += `<th class="${cur ? 'today' : ''}">${d}</th>`;
  }
  $('matrix-header-row').innerHTML = h;
  $('matrix-body').innerHTML = tasks.map((t) => {
    let r = `<td class="sticky-col"><div class="cell-name">
        <div class="cell-txt"><b title="${esc(t.title)}">${esc(t.title)}</b>
          <small>${t.startTime ? esc(t.startTime) : ''}${t.duration ? `<em>(${t.duration}p)</em>` : ''}</small></div>
        <div class="cell-actions">
          <button class="icon-btn" data-act="edit" data-id="${esc(t.id)}" aria-label="Sửa">${SVG_EDIT}</button>
          <button class="icon-btn danger" data-act="delete" data-id="${esc(t.id)}" aria-label="Xoá">${SVG_TRASH}</button>
        </div></div></td>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = `${state.year}-${pad(state.month + 1)}-${pad(d)}`;
      if (t.daysOfWeek.includes(new Date(state.year, state.month, d).getDay())) {
        const done = !!t.completions[ds];
        r += `<td><button class="mcheck ${done ? 'on' : ''}" data-act="toggle" data-id="${esc(t.id)}" data-date="${ds}" aria-label="Ngày ${d}">${done ? SVG_CHECK : ''}</button></td>`;
      } else r += '<td><span class="dotcell"></span></td>';
    }
    return `<tr>${r}</tr>`;
  }).join('');
}

/* Qua nửa đêm khi app đang mở → tự đổi sang ngày mới */
let shownDay = todayStr();
function checkDayChange() { if (todayStr() !== shownDay) { shownDay = todayStr(); render(); } }
setInterval(checkDayChange, 30000);

/* ================= Sự kiện ================= */
document.addEventListener('click', (e) => {
  if (e.target.id === 'modal-backdrop') return closeModal();
  const el = e.target.closest('[data-act]'); if (!el) return;
  const { act, id, date } = el.dataset;
  switch (act) {
    case 'add': openModal(null); break;
    case 'close': closeModal(); break;
    case 'save': saveTask(); break;
    case 'edit': { const t = state.tasks.find((x) => x.id === id); if (t) openModal(t); break; }
    case 'delete': deleteTask(id); break;
    case 'toggle': setDone(id, date); break;
    case 'start': startTimer(id); break;
    case 'pause': pauseTimer(id); break;
    case 'reset': resetTimer(id); break;
    case 'tab': switchView(el.dataset.tab); break;
    case 'month': changeMonth(parseInt(el.dataset.delta, 10)); break;
    case 'day': {
      const d = parseInt(el.dataset.day, 10);
      selectedDays = selectedDays.includes(d) ? selectedDays.filter((x) => x !== d) : [...selectedDays, d];
      refreshDayButtons(); break;
    }
    case 'sync': toast(navigator.onLine ? 'Đang đồng bộ…' : 'Đang ngoại tuyến — dữ liệu sẽ tự đẩy lên khi có mạng.'); syncNow(); break;
    case 'notify': requestNotificationAndSound(); break;
    case 'install': triggerInstall(); break;
  }
});
document.addEventListener('keydown', (e) => {
  if ($('modal-backdrop').classList.contains('hidden')) return;
  if (e.key === 'Escape') closeModal();
  if (e.key === 'Enter' && e.target.tagName === 'INPUT') saveTask();
});

/* ================= Cài đặt PWA ================= */
let deferredPrompt = null;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; $('btn-install-pwa').classList.remove('hidden'); });
window.addEventListener('appinstalled', () => { deferredPrompt = null; $('btn-install-pwa').classList.add('hidden'); toast('Đã cài đặt Kế Hoạch 🎉'); });
if (isIOS && !isStandalone()) $('btn-install-pwa').classList.remove('hidden');

function triggerInstall() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(() => { $('btn-install-pwa').classList.add('hidden'); deferredPrompt = null; });
  } else if (isIOS) {
    window.alert('Cài trên iPhone/iPad:\n1. Mở bằng Safari\n2. Bấm nút Chia sẻ (hình vuông có mũi tên)\n3. Chọn "Thêm vào MH chính"');
  }
}

if ('serviceWorker' in navigator && !NATIVE) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW lỗi:', err)));
}

/* ================= Khởi động ================= */
// Hẹn giờ đang chạy dở trước khi tải lại trang
for (const id of Object.keys(timers)) if (timers[id].running && timers[id].endAt <= Date.now()) setTimeout(() => finishTimer(id), 500);
updateBellButton();
render();
rescheduleNative(1500);
setSyncUI();
syncStatus = navigator.onLine ? 'idle' : 'offline';
scheduleSync(300);

window.KeHoach = { mergeLists, canonical, state, syncNow };   // phục vụ kiểm thử
})();
