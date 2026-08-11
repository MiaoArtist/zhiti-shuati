'use strict';

// ================= 存储层：IndexedDB（含 localStorage 迁移） =================
const LS_KEY = 'zhiti_shuati_v1';   // 旧版 localStorage 数据键
const CFG_KEY = 'zhiti_shuati_cfg'; // 云同步配置
const DB_NAME = 'zhiti_shuati_db';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbGet() {
  const d = await openDB();
  return new Promise((res, rej) => {
    const rq = d.transaction('kv', 'readonly').objectStore('kv').get('data');
    rq.onsuccess = () => res(rq.result || null);
    rq.onerror = () => rej(rq.error);
  });
}
async function dbPut(val) {
  const d = await openDB();
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, 'data');
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

let data = null;
async function loadData() {
  try {
    const d = await dbGet();
    if (d && Array.isArray(d.papers)) return d;
  } catch (e) { /* 降级 */ }
  try {
    const old = JSON.parse(localStorage.getItem(LS_KEY));
    if (old && Array.isArray(old.papers)) {
      await dbPut(old);
      localStorage.removeItem(LS_KEY);
      return old;
    }
  } catch (e) { /* ignore */ }
  return { version: 1, papers: [], records: {}, updatedAt: '' };
}
async function saveData() {
  data.updatedAt = new Date().toISOString();
  try { await dbPut(data); } catch (e) { console.warn('IndexedDB 写入失败', e); }
  schedulePush();
}

// ================= 云同步配置 =================
const cloud = { enabled: false, mode: 'github', url: '', repo: '', path: 'sync-data.json', token: '', lastSync: '' };
function loadCloudCfg() {
  try { Object.assign(cloud, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); } catch (e) { /* ignore */ }
  if (!cloud.mode) cloud.mode = 'github';
  if (!cloud.path) cloud.path = 'sync-data.json';
}
function saveCloudCfg() { localStorage.setItem(CFG_KEY, JSON.stringify(cloud)); }

let pushTimer = null;
function schedulePush() {
  if (!cloud.enabled) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushSync, 1500);
}
function syncBase() { return cloud.url.trim().replace(/\/+$/, '') + '/api/sync'; }
function syncReady() {
  if (!cloud.enabled) return false;
  if (cloud.mode === 'github') return !!(cloud.repo && cloud.token);
  return !!(cloud.url && cloud.token);
}
function b64enc(s) { return btoa(unescape(encodeURIComponent(s))); }
function b64dec(s) { return decodeURIComponent(escape(atob(s))); }

async function ghGet() {
  const r = await fetch(`https://api.github.com/repos/${cloud.repo}/contents/${cloud.path}`, {
    headers: { 'Authorization': 'Bearer ' + cloud.token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (r.status === 404) return { notFound: true };
  if (!r.ok) { const e = new Error('GitHub HTTP ' + r.status); e.status = r.status; throw e; }
  const meta = await r.json();
  return { content: b64dec(meta.content), sha: meta.sha };
}
async function ghPut(jsonStr, sha) {
  const r = await fetch(`https://api.github.com/repos/${cloud.repo}/contents/${cloud.path}`, {
    method: 'PUT',
    headers: { 'Authorization': 'Bearer ' + cloud.token, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'zhiti sync', content: b64enc(jsonStr), ...(sha ? { sha } : {}) }),
  });
  if (!r.ok) { const e = new Error('GitHub HTTP ' + r.status); e.status = r.status; throw e; }
}

async function pullSync(silent) {
  if (!syncReady()) return;
  try {
    let payload = null;
    if (cloud.mode === 'github') {
      const g = await ghGet();
      if (!g.notFound) payload = JSON.parse(g.content);
    } else {
      const r = await fetch(syncBase(), { headers: { 'X-Auth-Token': cloud.token } });
      if (r.status === 404) { /* 云端还没有数据 */ }
      else if (!r.ok) throw new Error('HTTP ' + r.status);
      else { const body = await r.json(); if (body.data) payload = body.data; }
    }
    if (payload) {
      mergeData(payload);
      if (!silent) toast('已同步云端最新数据');
    }
    cloud.lastSync = new Date().toLocaleTimeString();
    saveCloudCfg();
  } catch (e) {
    if (!silent) toast('同步拉取失败：' + e.message, 'error');
  }
}
async function pushSync() {
  if (!syncReady()) return;
  try {
    if (cloud.mode === 'github') {
      const jsonStr = JSON.stringify(data);
      for (let i = 0; i < 3; i++) {
        const g = await ghGet();
        try { await ghPut(jsonStr, g.notFound ? null : g.sha); break; }
        catch (e) { if (e.status === 409 && i < 2) continue; throw e; }
      }
    } else {
      const r = await fetch(syncBase(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Auth-Token': cloud.token },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    }
    cloud.lastSync = new Date().toLocaleTimeString();
    saveCloudCfg();
  } catch (e) { console.warn('同步推送失败', e); }
}
function mergeData(remote) {
  const localNewer = (data.updatedAt || '') >= (remote.updatedAt || '');
  const byId = new Map();
  for (const p of (data.papers || [])) byId.set(p.id, { local: p, remote: null });
  for (const p of (remote.papers || [])) {
    const e = byId.get(p.id);
    byId.set(p.id, { local: e ? e.local : null, remote: p });
  }
  const papers = [];
  for (const e of byId.values()) {
    if (e.local && e.remote) papers.push(localNewer ? e.local : e.remote);
    else papers.push(e.local || e.remote);
  }
  const records = { ...(data.records || {}) };
  for (const [k, v] of Object.entries(remote.records || {})) {
    const l = records[k];
    if (!l || (v.updatedAt || '') > (l.updatedAt || '')) records[k] = v;
  }
  data = { version: 1, papers, records, updatedAt: new Date().toISOString() };
  saveData();
}

// ================= 状态与工具 =================
let view = { name: 'home', paperIdx: 0, qIdx: 0, answered: false };
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg, type) {
  const d = document.createElement('div');
  d.textContent = msg;
  d.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:' + (type === 'error' ? '#c0564f' : '#333') + ';color:#fff;padding:10px 18px;border-radius:10px;z-index:99;font-size:14px';
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2600);
}
function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function recKey(p, q) { return p.id + '::' + q.id; }
function getRec(p, q) {
  return data.records[recKey(p, q)] || { status: 'unanswered', starred: false, insight: '', updatedAt: '' };
}
function setRec(p, q, patch) {
  const k = recKey(p, q);
  data.records[k] = Object.assign({}, data.records[k], patch, { updatedAt: new Date().toISOString() });
  saveData();
}
function curP() { return data.papers[view.paperIdx]; }
function curQ() { return (curP().questions || [])[view.qIdx]; }
function letterOf(s) {
  const str = String(s || '');
  const m = str.match(/^\s*([A-H])\s*[.、．)）:：]/) || str.match(/^\s*([A-H])\s*$/);
  return m ? m[1] : '';
}

// ================= 渲染 =================
const main = $('#app');
const tplHome = $('#tpl-home');
const tplPaper = $('#tpl-paper');
const tplSettings = $('#tpl-settings');

function render() {
  if (view.name === 'paper') renderPaper();
  else if (view.name === 'settings') renderSettings();
  else renderHome();
}

function renderHome() {
  main.innerHTML = tplHome.innerHTML;
  const list = $('#paper-list');
  if (!data.papers.length) { $('#home-empty').hidden = false; return; }
  list.innerHTML = data.papers.map((p, i) => {
    const total = (p.questions || []).length;
    let done = 0, wrong = 0, starred = 0;
    for (const q of p.questions || []) {
      const r = getRec(p, q);
      if (r.status !== 'unanswered') done++;
      if (r.status === 'wrong') wrong++;
      if (r.starred) starred++;
    }
    const pct = total ? Math.round(done / total * 100) : 0;
    return `<div class="paper-card" onclick="startPaper(${i})">
      <div class="paper-name">${esc(p.name)} <span class="badge subject">${esc(p.subject || '')}</span></div>
      <div class="paper-meta">${done}/${total} 已做 · 🔴 ${wrong} · ⭐ ${starred}</div>
      <div class="progress"><div style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}

function startPaper(i) {
  view = { name: 'paper', paperIdx: i, qIdx: 0, answered: false };
  renderPaper();
}

function renderPaper() {
  const p = data.papers[view.paperIdx];
  if (!p) { view.name = 'home'; renderHome(); return; }
  main.innerHTML = tplPaper.innerHTML;
  $('#paper-title').textContent = p.name;
  const qs = p.questions || [];
  const q = qs[view.qIdx];
  $('#paper-progress').textContent = `${view.qIdx + 1} / ${qs.length}`;
  if (!q) { main.innerHTML = '<div class="empty">这套卷没有题目</div>'; return; }

  const rec = getRec(p, q);
  $('#q-stem').textContent = q.stem;
  $('#btn-star').textContent = rec.starred ? '★ 已收藏' : '☆ 收藏';
  $('#btn-star').classList.toggle('starred', !!rec.starred);

  const opts = q.options || [];
  const isChoice = opts.length > 0;
  $('#q-essay').hidden = isChoice;
  $('#q-options').hidden = !isChoice;
  if (isChoice) {
    $('#q-options').innerHTML = opts.map(o => `<button class="opt-btn" data-opt="${esc(o)}" onclick="answerChoice(this)">${esc(o)}</button>`).join('');
  }
  view.answered = rec.status !== 'unanswered';
  if (view.answered) showAnswerPanel(rec, q);
  $('#q-answer').hidden = !view.answered;
  $('#q-insight').hidden = !view.answered;
  if (view.answered) {
    const ta = $('#insight-input');
    ta.value = rec.insight || '';
    ta.oninput = debounce(() => setRec(p, q, { insight: ta.value }), 400);
  }
  updateCounts();
  $('#btn-prev').disabled = view.qIdx === 0;
  $('#btn-next').textContent = view.qIdx === qs.length - 1 ? '完成' : '下一题';
}

function answerChoice(btn) {
  const p = curP(), q = curQ();
  if (view.answered) return;
  const ansLetter = letterOf(q.answer);
  const chosenLetter = letterOf(btn.dataset.opt);
  const correct = ansLetter && chosenLetter === ansLetter;
  setRec(p, q, { status: correct ? 'right' : 'wrong' });
  view.answered = true;
  $$('#q-options .opt-btn').forEach(b => {
    b.disabled = true;
    if (letterOf(b.dataset.opt) === ansLetter) b.classList.add('correct');
    else if (b === btn && !correct) b.classList.add('wrong');
  });
  showAnswerPanel(getRec(p, q), q);
  $('#q-answer').hidden = false;
  $('#q-insight').hidden = false;
  updateCounts();
}

function gradeEssay(status) {
  const p = curP(), q = curQ();
  setRec(p, q, { status });
  view.answered = true;
  showAnswerPanel(getRec(p, q), q);
  $('#q-answer').hidden = false;
  $('#q-insight').hidden = false;
  updateCounts();
}

function showAnswerPanel(rec, q) {
  const box = $('#q-answer');
  if (!box) return;
  const ans = q.answer || '（本题未提供答案）';
  const badge = rec.status === 'wrong' ? '<span style="color:var(--bad)"> 做错了</span>' : (rec.status === 'right' ? '<span style="color:var(--ok)"> 做对了</span>' : '');
  box.innerHTML = `<div class="ans-label">答案：${esc(ans)}${badge}</div>${q.analysis ? '<div style="margin-top:6px">' + esc(q.analysis) + '</div>' : ''}`;
  const ta = $('#insight-input');
  if (ta && !ta._bound) {
    ta._bound = true;
    ta.oninput = debounce(() => setRec(curP(), curQ(), { insight: ta.value }), 400);
  }
  if (ta) ta.value = rec.insight || '';
}

function updateCounts() {
  const p = curP();
  const qs = p.questions || [];
  let done = 0, wrong = 0;
  qs.forEach(q => { const r = getRec(p, q); if (r.status !== 'unanswered') done++; if (r.status === 'wrong') wrong++; });
  const el = $('#q-counts');
  if (el) el.textContent = `本卷进度：${done}/${qs.length} 已做 · 错 ${wrong} 题`;
}

function renderSettings() {
  main.innerHTML = tplSettings.innerHTML;
  $('#s-enabled').checked = cloud.enabled;
  $('#s-mode').value = cloud.mode;
  $('#s-repo').value = cloud.repo;
  $('#s-url').value = cloud.url;
  $('#s-token').value = cloud.token;
  $('#s-last').textContent = cloud.lastSync ? `上次同步：${cloud.lastSync}` : '尚未同步';
  updateSyncUI();
  $('#s-mode').addEventListener('change', updateSyncUI);
}

function updateSyncUI() {
  const gh = $('#s-mode').value === 'github';
  $('#s-repo-row').hidden = !gh;
  $('#s-url-row').hidden = gh;
  $('#s-token-label').textContent = gh ? 'GitHub 令牌（PAT，需仓库读写权限）' : '同步口令（SYNC_TOKEN）';
  $('#s-token').placeholder = gh ? 'github_pat_...' : '口令';
}

function nav(delta) {
  const qs = curP().questions || [];
  const n = view.qIdx + delta;
  if (n < 0 || n >= qs.length) return;
  view.qIdx = n;
  renderPaper();
}

// ================= 导入 / 导出 =================
async function importData(fileData) {
  if (!fileData || !Array.isArray(fileData.papers)) { toast('文件格式不对：缺少 papers', 'error'); return; }
  const before = data.papers.length;
  const byId = new Map(data.papers.map(p => [p.id, p]));
  for (const p of fileData.papers) byId.set(p.id, p);
  data.papers = [...byId.values()];
  let merged = 0;
  for (const [k, v] of Object.entries(fileData.records || {})) {
    const l = data.records[k];
    if (!l || (v.updatedAt || '') > (l.updatedAt || '')) { data.records[k] = v; merged++; }
  }
  await saveData();
  render();
  toast(`题库已更新（${before} → ${data.papers.length} 卷），记录合并 ${merged} 条`);
}

// ================= 事件 =================
function bind() {
  $('#btn-export').addEventListener('click', () => downloadJSON(`刷题记录-${new Date().toISOString().slice(0, 10)}.json`, data));
  $('#btn-cloud').addEventListener('click', () => { view = { name: 'settings' }; render(); });
  $('#import-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { importData(JSON.parse(r.result)); } catch (err) { toast('JSON 解析失败：' + err.message, 'error'); } };
    r.readAsText(f);
    e.target.value = '';
  });

  document.addEventListener('click', e => {
    const t = e.target;
    if (t.id === 'btn-back') { view = { name: 'home' }; render(); }
    else if (t.id === 'btn-prev') nav(-1);
    else if (t.id === 'btn-next') {
      if (view.qIdx === (curP().questions || []).length - 1) { view = { name: 'home' }; render(); }
      else nav(1);
    }
    else if (t.id === 'btn-star') {
      const p = curP(), q = curQ(), rec = getRec(p, q);
      setRec(p, q, { starred: !rec.starred });
      const b = $('#btn-star');
      b.textContent = rec.starred ? '☆ 收藏' : '★ 已收藏';
      b.classList.toggle('starred', rec.starred);
      toast(rec.starred ? '已取消收藏' : '已收藏（可同步到云端）');
    }
    else if (t.id === 'btn-right') gradeEssay('right');
    else if (t.id === 'btn-wrong') gradeEssay('wrong');
    else if (t.id === 'btn-sync-save') {
      cloud.enabled = $('#s-enabled').checked;
      cloud.mode = $('#s-mode').value;
      cloud.repo = $('#s-repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
      cloud.url = $('#s-url').value.trim();
      cloud.token = $('#s-token').value.trim();
      if (cloud.enabled && !syncReady()) {
        toast(cloud.mode === 'github' ? '开启云同步需要填仓库（用户名/仓库名）和令牌' : '开启云同步需要填地址和口令', 'error');
        return;
      }
      saveCloudCfg();
      if (cloud.enabled) { toast('正在连接云端…'); pullSync(false).then(() => { renderSettings(); toast('云同步已开启'); }); }
      else { toast('云同步已关闭（数据仍在本机）'); }
    }
    else if (t.id === 'btn-sync-now') {
      pullSync(false).then(() => pushSync()).then(() => {
        const el = $('#s-last');
        if (el) el.textContent = cloud.lastSync ? `上次同步：${cloud.lastSync}` : '尚未同步';
      });
    }
  });
}

// ================= 启动 =================
(async function init() {
  loadCloudCfg();
  data = await loadData();
  bind();
  render();
  if (cloud.enabled) pullSync(true);
})();
