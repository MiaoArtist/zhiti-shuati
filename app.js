'use strict';

// ---------- 数据层 ----------
const LS_KEY = 'zhiti_shuati_v1';
let data = loadData();
let view = { name: 'home', paperIdx: 0, qIdx: 0, answered: false };

function loadData() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY));
    if (d && Array.isArray(d.papers)) return d;
  } catch (e) { /* ignore */ }
  return { version: 1, papers: [], records: {} };
}
function saveData() { localStorage.setItem(LS_KEY, JSON.stringify(data)); }

function recKey(p, q) { return p.id + '::' + q.id; }
function getRec(p, q) {
  const r = data.records[recKey(p, q)];
  return r || { status: 'unanswered', starred: false, insight: '', updatedAt: '' };
}
function setRec(p, q, patch) {
  const k = recKey(p, q);
  data.records[k] = Object.assign({}, data.records[k], patch, { updatedAt: new Date().toISOString() });
  saveData();
}

// ---------- 工具 ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function toast(msg) {
  const d = document.createElement('div');
  d.textContent = msg;
  d.style.cssText = 'position:fixed;left:50%;bottom:40px;transform:translateX(-50%);background:#333;color:#fff;padding:10px 18px;border-radius:10px;z-index:99;font-size:14px';
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2500);
}
function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- 渲染 ----------
const main = $('#app');
const tplHome = $('#tpl-home');
const tplPaper = $('#tpl-paper');

function render() {
  if (view.name === 'home') renderHome();
  else renderPaper();
}

function renderHome() {
  main.innerHTML = tplHome.innerHTML;
  const list = $('#paper-list');
  if (!data.papers.length) {
    $('#home-empty').hidden = false;
    return;
  }
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

  // 心得回填
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
  const p = data.papers[view.paperIdx];
  const q = (p.questions || [])[view.qIdx];
  if (view.answered) return;
  const opts = q.options || [];
  const ansLetter = letterOf(q.answer);
  const chosenLetter = letterOf(btn.dataset.opt);
  const correct = ansLetter && chosenLetter === ansLetter;
  const status = correct ? 'right' : 'wrong';
  setRec(p, q, { status });
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
  const p = data.papers[view.paperIdx];
  const q = (p.questions || [])[view.qIdx];
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
  const wrongBadge = rec.status === 'wrong' ? '<span style="color:var(--bad)"> 做错了</span>' : (rec.status === 'right' ? '<span style="color:var(--ok)"> 做对了</span>' : '');
  box.innerHTML = `<div class="ans-label">答案：${esc(ans)}${wrongBadge}</div>${q.analysis ? '<div style="margin-top:6px">' + esc(q.analysis) + '</div>' : ''}`;
  const ta = $('#insight-input');
  if (ta && !ta._bound) {
    ta._bound = true;
    ta.oninput = debounce(() => setRec(curP(), curQ(), { insight: ta.value }), 400);
  }
  if (ta) ta.value = rec.insight || '';
}

// 保存心得时用当前 paper/question
function curP() { return data.papers[view.paperIdx]; }
function curQ() { return (curP().questions || [])[view.qIdx]; }

function letterOf(s) {
  const str = String(s || '');
  const m = str.match(/^\s*([A-H])\s*[.、．)）:：]/) || str.match(/^\s*([A-H])\s*$/);
  return m ? m[1] : '';
}

function updateCounts() {
  const p = data.papers[view.paperIdx];
  const qs = p.questions || [];
  let done = 0, wrong = 0;
  qs.forEach(q => {
    const r = getRec(p, q);
    if (r.status !== 'unanswered') done++;
    if (r.status === 'wrong') wrong++;
  });
  const el = $('#q-counts');
  if (el) el.textContent = `本卷进度：${done}/${qs.length} 已做 · 错 ${wrong} 题`;
}

// ---------- 事件 ----------
function bind() {
  $('#btn-export').addEventListener('click', () => {
    downloadJSON(`刷题记录-${new Date().toISOString().slice(0, 10)}.json`, data);
  });
  $('#import-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => importData(JSON.parse(r.result));
    r.readAsText(f);
    e.target.value = '';
  });
}

function importData(fileData) {
  if (!fileData || !Array.isArray(fileData.papers)) {
    toast('文件格式不对：缺少 papers');
    return;
  }
  // 题库以文件为准
  const beforeCount = data.papers.length;
  data.papers = fileData.papers;
  // 记录合并：冲突保留 updatedAt 较新
  const fileRecs = fileData.records || {};
  let merged = 0;
  for (const [k, v] of Object.entries(fileRecs)) {
    const local = data.records[k];
    if (!local || (v.updatedAt || '') > (local.updatedAt || '')) {
      data.records[k] = v;
      merged++;
    }
  }
  saveData();
  render();
  toast(`题库已更新（${beforeCount} → ${data.papers.length} 卷），记录合并 ${merged} 条`);
}

// ---------- 导航 ----------
function nav(delta) {
  const p = data.papers[view.paperIdx];
  const qs = p.questions || [];
  const n = view.qIdx + delta;
  if (n < 0 || n >= qs.length) return;
  view.qIdx = n;
  renderPaper();
}

document.addEventListener('click', e => {
  const t = e.target;
  if (t.id === 'btn-back') { view = { name: 'home' }; render(); }
  else if (t.id === 'btn-prev') nav(-1);
  else if (t.id === 'btn-next') { if (view.qIdx === (data.papers[view.paperIdx].questions || []).length - 1) { view = { name: 'home' }; render(); } else nav(1); }
  else if (t.id === 'btn-star') {
    const p = curP(), q = curQ(), rec = getRec(p, q);
    setRec(p, q, { starred: !rec.starred });
    const b = $('#btn-star');
    b.textContent = rec.starred ? '☆ 收藏' : '★ 已收藏';
    b.classList.toggle('starred', rec.starred);
    toast(rec.starred ? '已取消收藏' : '已收藏（会随导出带回织题）');
  }
  else if (t.id === 'btn-right') gradeEssay('right');
  else if (t.id === 'btn-wrong') gradeEssay('wrong');
});

bind();
render();
