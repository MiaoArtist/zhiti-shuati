'use strict';

// ================= 存储层：IndexedDB（含 localStorage 迁移） =================
const LS_KEY = 'zhiti_shuati_v1';   // 旧版 localStorage 数据键
const CFG_KEY = 'zhiti_shuati_cfg'; // 云同步配置
const CFG_EXPORT = 'zhiti_shuati_last_export'; // 上次成功导出的时间点（仅本机）
const DB_NAME = 'zhiti_shuati_db';
// 手机/平板（触摸设备）隐藏导出，专注刷题
const IS_MOBILE = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

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
let dirty = false; // 有未同步到云端的本地改动
let mode = localStorage.getItem('zhiti_mode') === 'back' ? 'back' : 'practice'; // practice=刷题模式, back=背题模式
let lastExportAt = localStorage.getItem(CFG_EXPORT) || '';

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
  if (cloud.enabled) { dirty = true; setSyncChip('dirty'); }
  schedulePush();
}

// ================= 云同步配置 =================
const cloud = { enabled: false, mode: 'github', url: '', repo: 'MiaoArtist/zhiti-shuati-sync', path: 'sync-data.json', token: '', lastSync: '' };
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

// ---------- 同步状态 UI ----------
function applySyncChip(el, state) {
  if (!el) return;
  if (!cloud.enabled) { el.textContent = '未开启同步'; el.className = 'sync-chip off'; return; }
  if (state === 'syncing') { el.textContent = '同步中…'; el.className = 'sync-chip syncing'; return; }
  if (state === 'dirty' || dirty) { el.textContent = '有未同步更改'; el.className = 'sync-chip dirty'; return; }
  el.textContent = cloud.lastSync ? '已同步 ' + cloud.lastSync : '待同步';
  el.className = 'sync-chip ok';
}
function setSyncChip(state) {
  applySyncChip($('#sync-chip'), state);
  applySyncChip($('#menu-sync-chip'), state);
}
let bannerTimer = null;
function showBanner(text, kind) {
  const b = $('#sync-banner');
  if (!b) return;
  b.textContent = text;
  b.className = 'sync-banner ' + (kind === 'syncing' ? 'syncing' : kind === 'error' ? 'error' : 'ok');
  b.hidden = false;
  clearTimeout(bannerTimer);
  if (kind !== 'syncing') bannerTimer = setTimeout(() => { b.hidden = true; }, 3000);
}
async function doSync() {
  if (!syncReady()) {
    toast('请先到「设置」里配置并开启云同步', 'error');
    view = { name: 'settings' }; render();
    return;
  }
  showBanner('同步中…', 'syncing');
  setSyncChip('syncing');
  const pulled = await pullSync(false);
  const pushed = await pushSync();
  if (pulled && pushed) {
    showBanner('同步成功', 'ok');
    setSyncChip('synced');
    toast('同步成功');
  } else {
    showBanner('同步失败：请检查网络或设置', 'error');
    setSyncChip(pushed ? 'synced' : 'dirty');
  }
}

async function pullSync(silent) {
  if (!syncReady()) return false;
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
    setSyncChip('synced');
    return true;
  } catch (e) {
    if (!silent) toast('同步拉取失败：' + e.message, 'error');
    return false;
  }
}
async function pushSync() {
  if (!syncReady()) return false;
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
    dirty = false;
    setSyncChip('synced');
    return true;
  } catch (e) {
    console.warn('同步推送失败', e);
    setSyncChip('dirty');
    return false;
  }
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
let view = { name: 'home', paperIdx: 0, qIdx: 0, order: null, shuffle: false, filters: { status: '', type: '' }, revealedIds: new Set() };
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
function posKey(paperId) { return 'zhiti_shuati_pos_' + paperId; }
function getRec(p, q) {
  return data.records[recKey(p, q)] || { status: 'unanswered', starred: false, insight: '', updatedAt: '' };
}
function setRec(p, q, patch) {
  const k = recKey(p, q);
  data.records[k] = Object.assign({}, data.records[k], patch, { updatedAt: new Date().toISOString() });
  saveData();
}
function curP() { return data.papers[view.paperIdx]; }
function curQ() { return (curP().questions || [])[(view.order || [])[view.qIdx]]; }
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
  updateMenuModeVisibility();
}

function updateMenuModeVisibility() {
  const mm = $('#menu-mode');
  if (mm) mm.hidden = view.name !== 'paper';
  const ov = $('#btn-menu-overview');
  if (ov) ov.hidden = view.name !== 'paper';
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
      <div class="paper-name">${esc(p.name)} <span class="badge subject">${esc(p.subject || '')}</span>
        <button class="btn small paper-rename" onclick="event.stopPropagation();renamePaper(${i})" title="重命名套题">✏️</button>
        <button class="btn small paper-delete" onclick="event.stopPropagation();deletePaper(${i})" title="删除套卷">🗑</button>
      </div>
      <div class="paper-meta">${done}/${total} 已做 · 🔴 ${wrong} · ⭐ ${starred}</div>
      <div class="progress"><div style="width:${pct}%"></div></div>
    </div>`;
  }).join('');
}

function startPaper(i) {
  const p = data.papers[i];
  const saved = p ? parseInt(localStorage.getItem(posKey(p.id)) || '-1', 10) : -1;
  view = { name: 'paper', paperIdx: i, qIdx: saved >= 0 ? saved : 0, order: null, shuffle: false, filters: { status: '', type: '' }, revealedIds: new Set() };
  render(); // 走 render() 以确保手机端顶部菜单里的「背题/刷题」入口正确显示
}

function renamePaper(i) {
  const p = data.papers[i];
  if (!p) return;
  const name = prompt('重命名套题：', p.name);
  if (!name || !name.trim() || name.trim() === p.name) return;
  p.name = name.trim();
  saveData();
  renderHome();
  toast('套题已重命名，导出数据将自动使用新名称');
}

function deletePaper(i) {
  const p = data.papers[i];
  if (!p) return;
  if (!confirm(`确认删除套卷「${p.name}」？\n该卷的全部做题记录也会一并删除。`)) return;
  data.papers.splice(i, 1);
  const prefix = p.id + '::';
  Object.keys(data.records).forEach(k => { if (k.startsWith(prefix)) delete data.records[k]; });
  saveData();
  if (view.name === 'paper' && view.paperIdx === i) view.name = 'home';
  render();
  toast('套卷已删除');
}

function isEssay(q) { return q.type === 'essay' || !((q.options || []).length > 0); }
function passesFilter(q) {
  const r = getRec(curP(), q);
  if (view.filters.status === 'wrong' && r.status !== 'wrong') return false;
  if (view.filters.status === 'starred' && !r.starred) return false;
  if (view.filters.status === 'unanswered' && r.status !== 'unanswered') return false;
  if (view.filters.type === 'choice' && isEssay(q)) return false;
  if (view.filters.type === 'essay' && !isEssay(q)) return false;
  return true;
}
function buildOrder() {
  const qs = curP().questions || [];
  const cur = (view.order && view.order[view.qIdx] != null) ? view.order[view.qIdx] : (view.qIdx || 0);
  let idxs = qs.map((_, i) => i).filter(i => passesFilter(qs[i]));
  if (view.shuffle) {
    for (let i = idxs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
    }
  }
  view.order = idxs;
  const pos = idxs.indexOf(cur);
  view.qIdx = pos >= 0 ? pos : 0;
}
function setMode(m) {
  mode = m;
  localStorage.setItem('zhiti_mode', m);
  renderPaper();
}

function renderPaper() {
  const p = data.papers[view.paperIdx];
  if (!p) { view.name = 'home'; renderHome(); return; }
  main.innerHTML = tplPaper.innerHTML;
  $('#paper-title').textContent = p.name;
  const qs = p.questions || [];
  $('#pf-status').value = view.filters.status;
  $('#pf-type').value = view.filters.type;
  $('#pf-shuffle').checked = !!view.shuffle;
  ['btn-mode-practice', 'btn-menu-mode-practice'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.classList.toggle('active', mode === 'practice');
  });
  ['btn-mode-back', 'btn-menu-mode-back'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.classList.toggle('active', mode === 'back');
  });
  if (!view.order) buildOrder();
  const list = view.order || [];
  if (!list.length) {
    $('#qcard').innerHTML = '<div class="empty">没有符合条件的题目，试试调整上方筛选</div>';
    return;
  }
  if (view.qIdx >= list.length) view.qIdx = list.length - 1;
  const q = qs[list[view.qIdx]];
  const label = mode === 'back' ? '背题' : '刷题';
  $('#mode-chip').textContent = `${label} ${view.qIdx + 1} / ${list.length}`;
  $('#paper-progress').textContent = `${view.qIdx + 1} / ${list.length}`;

  const rec = getRec(p, q);
  $('#q-stem').textContent = q.stem;
  updateStarButton();

  const opts = q.options || [];
  const isChoice = opts.length > 0;
  $('#q-essay').hidden = isChoice;
  $('#q-options').hidden = !isChoice;
  if (isChoice) {
    $('#q-options').innerHTML = opts.map(o => `<button class="opt-btn" data-opt="${esc(o)}" onclick="answerChoice(this)">${esc(o)}</button>`).join('');
  } else {
    const revealed = mode === 'back' || view.revealedIds.has(recKey(p, q));
    $('#btn-reveal').style.display = revealed ? 'none' : '';
    $('#btn-right').style.display = revealed ? '' : 'none';
    $('#btn-wrong').style.display = revealed ? '' : 'none';
  }

  const revealed = mode === 'back' || view.revealedIds.has(recKey(p, q));
  $('#q-answer').hidden = !revealed;
  $('#q-insight').hidden = !revealed;
  if (revealed) {
    showAnswerPanel(rec, q);
    const ta = $('#insight-input');
    if (ta) ta.value = rec.insight || '';
  }
  updateCounts();
  $('#btn-prev').disabled = view.qIdx === 0;
  $('#btn-next').textContent = view.qIdx === list.length - 1 ? '完成' : '下一题';
  attachSwipe();
}

function answerChoice(btn) {
  const p = curP(), q = curQ();
  const ansLetter = letterOf(q.answer);
  const chosenLetter = letterOf(btn.dataset.opt);
  const correct = ansLetter && chosenLetter === ansLetter;
  setRec(p, q, { status: correct ? 'right' : 'wrong' });
  view.revealedIds.add(recKey(p, q));
  $$('#q-options .opt-btn').forEach(b => {
    b.classList.remove('correct', 'wrong', 'chosen');
    if (letterOf(b.dataset.opt) === ansLetter) b.classList.add('correct');
  });
  btn.classList.add(correct ? 'chosen' : 'wrong');
  showAnswerPanel(getRec(p, q), q);
  $('#q-answer').hidden = false;
  $('#q-insight').hidden = false;
  updateCounts();
}

function gradeEssay(status) {
  const p = curP(), q = curQ();
  setRec(p, q, { status });
  view.revealedIds.add(recKey(p, q));
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
    ta.oninput = debounce(() => {
      const p = curP(), q = curQ(), r = getRec(p, q);
      const v = ta.value;
      if (v.trim() && !r.starred) {
        setRec(p, q, { insight: v, starred: true });
        updateStarButton();
        toast('已收藏（写了心得）');
      } else {
        setRec(p, q, { insight: v });
      }
    }, 400);
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

// ---------- 题概览 ----------
function showOverview() {
  const p = curP();
  if (!p || !(p.questions || []).length) { toast('当前试卷没有题目', 'error'); return; }
  if (!view.order) buildOrder();
  const list = view.order || [];
  const grid = list.map((qi, pos) => {
    const q = p.questions[qi];
    const r = getRec(p, q);
    const cls = r.status === 'right' ? 'ok' : r.status === 'wrong' ? 'bad' : 'none';
    return `<div class="ov-cell ${cls}" onclick="gotoOverview(${pos})">${String(pos + 1)}</div>`;
  }).join('');
  $('#modal-root').innerHTML = `<div class="modal-mask"><div class="modal">
    <div class="modal-head"><strong>题概览 · ${esc(p.name)}</strong><button class="close" onclick="closeOverview()">×</button></div>
    <div class="overview-grid">${grid}</div>
    <div class="modal-foot"><span class="qmeta">绿=对 · 红=错 · 灰=未做</span><div style="flex:1"></div><button class="btn" onclick="closeOverview()">关闭</button></div>
  </div></div>`;
}

function gotoOverview(pos) {
  const list = view.order || [];
  if (list[pos] == null) return;
  view.qIdx = pos;
  const p = curP();
  if (p) localStorage.setItem(posKey(p.id), String(list[pos]));
  closeOverview();
  renderPaper();
}

function closeOverview() { $('#modal-root').innerHTML = ''; }

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
  const n = view.qIdx + delta;
  if (n < 0 || n >= (view.order || []).length) return;
  view.qIdx = n;
  const p = curP();
  if (p && view.order && view.order[view.qIdx] != null) {
    localStorage.setItem(posKey(p.id), String(view.order[view.qIdx]));
  }
  renderPaper();
}
function nextQuestion() {
  if (view.qIdx >= (view.order || []).length - 1) { view = { name: 'home' }; render(); }
  else nav(1);
}
function updateStarButton() {
  const p = curP(), q = curQ(), rec = getRec(p, q);
  const b = $('#btn-star');
  if (!b) return;
  b.textContent = rec.starred ? '★ 已收藏' : '☆ 收藏';
  b.classList.toggle('starred', !!rec.starred);
}

// ---------- 触摸手势：左右翻页 / 上滑收藏 ----------
const SWIPE_X_THRESHOLD = 60;   // 横向翻页位移阈值
const SWIPE_FOLLOW = 0.45;      // 手指拖动时卡片跟随系数（低一点，拖动阻尼感更强）
const SWIPE_UP_THRESHOLD = 70;  // 上滑收藏位移阈值
let _swipeHintFired = false;

function attachSwipe() {
  if (!IS_MOBILE) return;
  const root = main; // #app，覆盖整张试卷内容，题目卡片上下区域都能滑
  if (!root) return;
  if (root.dataset.swipeBound) return; // main 元素常驻，只绑定一次，避免重复触发
  root.dataset.swipeBound = '1';
  let sx = 0, sy = 0, st = 0, sScroll = 0, dx = 0, dy = 0, active = false, selecting = false;
  // 只忽略真正的输入控件/链接/可编辑区；按钮、选项按钮允许滑动（点击仍正常）
  const ignore = e => e.target && e.target.closest && e.target.closest('input, select, textarea, a, [contenteditable]');
  const card = () => $('#qcard');
  // 先恢复 transition，再在下一帧清 transform：让未达阈值的回弹走平滑动画
  const springBack = c => {
    if (!c) return;
    c.classList.remove('swipe-left', 'swipe-right');
    c.classList.remove('swiping-x');
    requestAnimationFrame(() => { if (c) c.style.transform = ''; });
  };
  const reset = () => {
    active = false;
    selecting = false;
    dx = dy = 0;
    _swipeHintFired = false;
    springBack(card());
  };
  // 一旦出现系统文本选区（长按选择/复制），本次触摸切换为“允许原生选择”，不再翻页
  document.addEventListener('selectionchange', () => { if (active) selecting = true; });
  root.addEventListener('touchstart', e => {
    if (ignore(e)) return;
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; st = Date.now(); sScroll = window.scrollY;
    dx = 0; dy = 0; active = true; selecting = !!(window.getSelection && window.getSelection().toString()); _swipeHintFired = false;
  }, { passive: true });
  root.addEventListener('touchmove', e => {
    if (!active || ignore(e) || selecting) return;
    const t = e.touches[0];
    dx = t.clientX - sx; dy = t.clientY - sy;
    // 横向占优且有明显位移：卡片跟随 + 左右提示 + 阻止文本选择
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 30) {
      e.preventDefault();
      const c = card();
      if (c) {
        c.style.transform = `translateX(${dx * SWIPE_FOLLOW}px)`;
        c.classList.add('swiping-x');
        c.classList.toggle('swipe-left', dx < -SWIPE_X_THRESHOLD);
        c.classList.toggle('swipe-right', dx > SWIPE_X_THRESHOLD);
      }
      if (!_swipeHintFired && Math.abs(dx) >= SWIPE_X_THRESHOLD) {
        _swipeHintFired = true;
      }
    }
  }, { passive: false });
  root.addEventListener('touchend', e => {
    if (!active) return;
    const t = e.changedTouches[0];
    dx = t.clientX - sx; dy = t.clientY - sy;
    const dur = Date.now() - st;
    const scrolled = Math.abs(window.scrollY - sScroll) > 30;
    const selectingNow = selecting || !!(window.getSelection && window.getSelection().toString());
    active = false;
    selecting = false;
    springBack(card());
    // 复制/选取文本时不翻页
    if (selectingNow) return;
    // 左右翻页：放宽角度与时长，上下滚动过程中横滑也能生效
    if (Math.abs(dx) >= SWIPE_X_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.15) {
      if (dx < 0) nextQuestion(); else nav(-1);
      return;
    }
    // 上滑收藏
    if (!scrolled && dy < -SWIPE_UP_THRESHOLD && Math.abs(dy) > Math.abs(dx) * 1.2 && dur < 450) {
      const p = curP(), q = curQ(), r = getRec(p, q);
      setRec(p, q, { starred: !r.starred });
      updateStarButton();
      toast(r.starred ? '已取消收藏' : '已收藏（上滑）');
    }
  }, { passive: true });
  root.addEventListener('touchcancel', reset);
}

// ---------- 顶部展开菜单 ----------
function toggleMenu() {
  const m = $('#top-menu');
  if (m) m.hidden = !m.hidden;
}
function closeMenu() {
  const m = $('#top-menu');
  if (m) m.hidden = true;
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

// ---------- 导出收藏题（仅本机） ----------
let exportRows = [];
function openExport() {
  exportRows = [];
  for (const p of data.papers || []) {
    for (const q of p.questions || []) {
      const rec = getRec(p, q);
      if (rec.starred) exportRows.push({ p, q, rec });
    }
  }
  if (!exportRows.length) { toast('还没有收藏的题', 'error'); return; }
  const byPaper = new Map();
  exportRows.forEach((r, i) => {
    if (!byPaper.has(r.p.id)) byPaper.set(r.p.id, { p: r.p, rows: [] });
    byPaper.get(r.p.id).rows.push({ ...r, i });
  });
  const groups = [...byPaper.values()].map(g => `
    <div class="exp-group">
      <div class="exp-paper">${esc(g.p.name)} <span class="badge">${g.rows.length} 题</span></div>
      ${g.rows.map(r => `
        <label class="exp-row">
          <input type="checkbox" class="exp-check" data-idx="${r.i}" ${defaultChecked(r.rec) ? 'checked' : ''}>
          <span class="exp-stem">${esc(r.q.stem)}</span>
          <span class="badge">${r.rec.status === 'wrong' ? '错' : (r.rec.status === 'right' ? '对' : '未做')}</span>
        </label>`).join('')}
    </div>`).join('');
  $('#modal-root').innerHTML = `<div class="modal-mask"><div class="modal">
    <div class="modal-head"><strong>导出收藏题（共 ${exportRows.length} 题）</strong><button class="close" onclick="closeExportModal()">×</button></div>
    <p class="qmeta">默认勾选自上次导出后新收藏或变动的题；只有「导出并保存」后才算一次导出。</p>
    <div class="exp-body">${groups}</div>
    <div class="modal-foot">
      <span id="exp-count" class="qmeta">已选择 0 题</span>
      <div style="flex:1"></div>
      <button class="btn" onclick="closeExportModal()">取消</button>
      <button class="btn primary" onclick="confirmExport()">导出并保存</button>
    </div>
  </div></div>`;
  updateExportCount();
  $('#modal-root').addEventListener('change', e => { if (e.target.classList && e.target.classList.contains('exp-check')) updateExportCount(); });
}
function defaultChecked(rec) {
  return !lastExportAt || (rec.updatedAt || '') > lastExportAt;
}
function updateExportCount() {
  const n = $$('#modal-root .exp-check:checked').length;
  const el = $('#exp-count');
  if (el) el.textContent = `已选择 ${n} 题`;
}
function closeExportModal() { $('#modal-root').innerHTML = ''; }
function confirmExport() {
  const idxs = $$('#modal-root .exp-check:checked').map(cb => +cb.dataset.idx);
  if (!idxs.length) { toast('至少勾选一题', 'error'); return; }
  const byPaper = new Map();
  idxs.forEach(i => {
    const r = exportRows[i];
    if (!byPaper.has(r.p.id)) byPaper.set(r.p.id, { paper: r.p, questions: [], keys: [] });
    const g = byPaper.get(r.p.id);
    g.questions.push(r.q);
    g.keys.push(r.p.id + '::' + r.q.id);
  });
  const papers = [...byPaper.values()].map(g => ({ ...g.paper, questions: g.questions }));
  const records = {};
  [...byPaper.values()].forEach(g => g.keys.forEach(k => { if (data.records[k]) records[k] = data.records[k]; }));
  downloadJSON(`刷题-收藏-${new Date().toISOString().slice(0, 10)}.json`, { version: 1, papers, records, updatedAt: data.updatedAt });
  lastExportAt = new Date().toISOString();
  localStorage.setItem(CFG_EXPORT, lastExportAt);
  closeExportModal();
  toast(`已导出 ${idxs.length} 题（${papers.length} 卷）`);
}

// ================= 事件 =================
function bind() {
  if (IS_MOBILE) {
    const b = $('#btn-export'); if (b) b.style.display = 'none';
    const mb = $('#btn-menu-export'); if (mb) mb.style.display = 'none';
  }
  $('#btn-sync').addEventListener('click', doSync);
  $('#btn-settings').addEventListener('click', () => { view = { name: 'settings' }; render(); });
  $('#btn-export').addEventListener('click', openExport);
  $('#import-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { importData(JSON.parse(r.result)); } catch (err) { toast('JSON 解析失败：' + err.message, 'error'); } };
    r.readAsText(f);
    e.target.value = '';
  });

  // 顶部展开菜单
  $('#btn-menu').addEventListener('click', e => { e.stopPropagation(); toggleMenu(); });
  document.addEventListener('click', e => {
    const m = $('#top-menu');
    if (m && !m.hidden && !e.target.closest('.topbar')) closeMenu();
  });
  $('#btn-menu-sync').addEventListener('click', () => { closeMenu(); doSync(); });
  $('#btn-menu-settings').addEventListener('click', () => { closeMenu(); view = { name: 'settings' }; render(); });
  $('#btn-menu-export').addEventListener('click', () => { closeMenu(); openExport(); });
  $('#import-file-menu').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { importData(JSON.parse(r.result)); } catch (err) { toast('JSON 解析失败：' + err.message, 'error'); } };
    r.readAsText(f);
    e.target.value = '';
  });
  $('#btn-menu-mode-practice').addEventListener('click', () => { closeMenu(); setMode('practice'); });
  $('#btn-menu-mode-back').addEventListener('click', () => { closeMenu(); setMode('back'); });
  $('#btn-menu-overview').addEventListener('click', () => { closeMenu(); showOverview(); });

  document.addEventListener('click', e => {
    const t = e.target;
    if (t.id === 'btn-back') { view = { name: 'home' }; render(); }
    else if (t.id === 'btn-overview-top') showOverview();
    else if (t.id === 'btn-prev') nav(-1);
    else if (t.id === 'btn-next') nextQuestion();
    else if (t.id === 'btn-star') {
      const p = curP(), q = curQ(), rec = getRec(p, q);
      setRec(p, q, { starred: !rec.starred });
      updateStarButton();
      toast(rec.starred ? '已取消收藏' : '已收藏（可同步到云端）');
    }
    else if (t.id === 'btn-right') gradeEssay('right');
    else if (t.id === 'btn-wrong') gradeEssay('wrong');
    else if (t.id === 'btn-reveal') { view.revealedIds.add(recKey(curP(), curQ())); renderPaper(); }
    else if (t.id === 'btn-mode-practice') setMode('practice');
    else if (t.id === 'btn-mode-back') setMode('back');
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
      if (cloud.enabled) { renderSettings(); doSync(); }
      else { setSyncChip(); toast('云同步已关闭（数据仍在本机）'); }
    }
    else if (t.id === 'btn-sync-now') {
      doSync().then(() => {
        const el = $('#s-last');
        if (el) el.textContent = cloud.lastSync ? `上次同步：${cloud.lastSync}` : '尚未同步';
      });
    }
  });

  document.addEventListener('change', e => {
    if (e.target.id === 'pf-status') { view.filters.status = e.target.value; buildOrder(); renderPaper(); }
    else if (e.target.id === 'pf-type') { view.filters.type = e.target.value; buildOrder(); renderPaper(); }
    else if (e.target.id === 'pf-shuffle') { view.shuffle = e.target.checked; buildOrder(); renderPaper(); }
  });
}

// ================= 启动 =================
(async function init() {
  loadCloudCfg();
  data = await loadData();
  bind();
  render();
  setSyncChip();
  if (cloud.enabled) pullSync(true);
})();
