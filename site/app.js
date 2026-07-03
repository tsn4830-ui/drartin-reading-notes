/* 文獻雷達 — 前端（純靜態版，無後端；已看/投票存各訪客瀏覽器 localStorage）*/
const LS_ACT = 'rr_actions_v1';     // 各篇 {item_id:{vote,seen}}
const LS_TOPIC = 'rr_topics_v1';    // 主題開關 {group:bool}
const LS_FILT = 'rr_filters_v1';    // {badge,sort,search,showSeen}
const LS_VISIT = 'rr_visit_v1';     // {prev,last}

let DATA = null;
let actions = load(LS_ACT, {});
let topics = load(LS_TOPIC, null);
let filt = load(LS_FILT, {badge:'all', sort:'score', search:'', showSeen:false});
let visit = resolveVisit();
let collectUrl = '';                 // 按讚匯入 Zotero 的中繼網址（來自 collect.config.json）
const seenAtLoad = new Set();        // 只隱藏「載入前就已看」的；本 session 新點的留著
let headCollapsed = false;           // 於 init() 依螢幕寬度 / localStorage 決定

function load(k,d){ try{return JSON.parse(localStorage.getItem(k))??d}catch{return d} }
function save(k,v){ localStorage.setItem(k, JSON.stringify(v)); }

// 回訪：跨「日」才滾動
function resolveVisit(){
  const today = new Date().toISOString().slice(0,10);
  let v = load(LS_VISIT, null);
  if(!v){ v={prev:null, last:today}; }
  else if(v.last !== today){ v = {prev:v.last, last:today}; }
  save(LS_VISIT, v);
  return v;
}

async function init(){
  const r = await fetch('papers.json?_=' + Date.now());
  DATA = await r.json();
  try{ const c = await (await fetch('collect.config.json?_=' + Date.now())).json(); collectUrl = (c.url||'').trim(); }catch{}
  if(topics===null){ // 首次：用 config default_on
    topics = {};
    for(const [k,v] of Object.entries(DATA.topic_groups)) topics[k] = v.default_on;
    save(LS_TOPIC, topics);
  } else { // config 新增了主題 → 補上（預設開）
    for(const [k,v] of Object.entries(DATA.topic_groups))
      if(!(k in topics)) topics[k] = v.default_on;
  }
  document.getElementById('meta').textContent =
    `更新 ${DATA.updated}｜${DATA.counts.exported} 篇`;
  const stored = load('rr_headcollapse_v1', null);
  headCollapsed = (stored===null) ? false : stored;   // 預設展開；用過折疊鈕後記住偏好
  for(const [id,a] of Object.entries(actions)) if(a && a.seen) seenAtLoad.add(id);
  buildTopics();
  buildVisitBanner();
  bindFilters();
  bindHeadToggle();
  applyHeadCollapse();
  render();
}

function bindHeadToggle(){
  const btn = document.getElementById('headToggle');
  if(!btn) return;
  btn.onclick = () => {
    headCollapsed = !headCollapsed;
    save('rr_headcollapse_v1', headCollapsed);
    applyHeadCollapse();
  };
}
function applyHeadCollapse(){
  const ex = document.getElementById('headExtra');
  const btn = document.getElementById('headToggle');
  if(!ex) return;
  ex.classList.toggle('hidden', headCollapsed);
  if(btn){
    btn.classList.toggle('on', !headCollapsed);
    btn.textContent = headCollapsed ? '▶' : '▼';
  }
}

function buildTopics(){
  const box = document.getElementById('topics');
  box.innerHTML = '';
  for(const [k,v] of Object.entries(DATA.topic_groups)){
    const b = document.createElement('div');
    b.className = 'topic' + (topics[k] ? ' on' : '');
    b.textContent = v.label;
    b.onclick = () => { topics[k]=!topics[k]; save(LS_TOPIC,topics); b.classList.toggle('on'); render(); };
    box.appendChild(b);
  }
}

function buildVisitBanner(){
  if(!visit.prev) return;
  const n = DATA.papers.filter(p => p.first_seen >= visit.prev && passTopic(p)).length;
  if(!n) return;
  const el = document.getElementById('visitBanner');
  const labelOff = `✨ 自上次造訪(${visit.prev})以來新增 ${n} 篇 — 點此只看這些`;
  const labelOn  = `✨ 只看新增 ${n} 篇中 — 點此恢復全部`;
  el.textContent = filt.badge==='visit' ? labelOn : labelOff;
  el.classList.remove('hidden');
  el.onclick = () => {
    filt.badge = (filt.badge==='visit') ? 'all' : 'visit';
    save(LS_FILT,filt); syncBadgeUI();
    el.textContent = filt.badge==='visit' ? labelOn : labelOff;
    render();
  };
}

function bindFilters(){
  const s = document.getElementById('search');
  s.value = filt.search || '';
  s.oninput = () => { filt.search=s.value; save(LS_FILT,filt); render(); };
  const sort = document.getElementById('sort');
  sort.value = filt.sort;
  sort.onchange = () => { filt.sort=sort.value; save(LS_FILT,filt); render(); };
  const ss = document.getElementById('showSeen');
  if(ss){ ss.checked = !!filt.showSeen;
    ss.onchange = () => { filt.showSeen=ss.checked; save(LS_FILT,filt); render(); }; }
  document.querySelectorAll('#badgeFilter .chip').forEach(c => {
    c.onclick = () => { filt.badge=c.dataset.badge; save(LS_FILT,filt); syncBadgeUI(); render(); };
  });
  syncBadgeUI();
}
function syncBadgeUI(){
  document.querySelectorAll('#badgeFilter .chip').forEach(c =>
    c.dataset.on = (c.dataset.badge===filt.badge) ? '1' : '0');
}

function passTopic(p){ return topics[p.group]; }
function passBadge(p){
  switch(filt.badge){
    case 'oa': return !!p.oa_pdf_url;
    case 'new': return p.isNew;
    case 'visit': return visit.prev && p.first_seen >= visit.prev;
    default: return true;
  }
}
function passSearch(p){
  const q = (filt.search||'').trim().toLowerCase();
  if(!q) return true;
  return (p.title+' '+p.authors+' '+p.source_name).toLowerCase().includes(q);
}
function passSeen(p){
  if(filt.showSeen) return true;
  const a = actions[p.item_id] || {};
  if(!a.seen) return true;
  return !seenAtLoad.has(p.item_id);
}

function render(){
  const list = document.getElementById('list');
  const base = DATA.papers.filter(p => passTopic(p) && passBadge(p) && passSearch(p));
  const ps = base.filter(passSeen);
  ps.sort(filt.sort==='date'
    ? (a,b)=> (b.pub_date||b.first_seen).localeCompare(a.pub_date||a.first_seen)
    : (a,b)=> b.score - a.score);
  list.innerHTML = '';
  for(const p of ps) list.appendChild(card(p));
  const hidden = base.length - ps.length;
  document.getElementById('count').textContent =
    `顯示 ${ps.length} 篇` + (hidden>0 ? `（隱藏 ${hidden} 已看）` : '');
}

function card(p){
  const a = actions[p.item_id] || {};
  const el = document.createElement('div');
  el.className = 'card' + (a.vote==='down'?' down':'') + (a.seen?' seen':'');

  const sc = document.createElement('div');
  sc.className = 'score' + (p.score>=5?' hi':p.score>=3?' mid':'');
  sc.textContent = p.score;

  const body = document.createElement('div'); body.style.flex='1';
  const titleLink = p.url
    ? `<a class="c-title" href="${p.url}" target="_blank" rel="noopener">${esc(p.title)}</a>`
    : `<div class="c-title">${esc(p.title)}</div>`;
  const title = titleLink +
    `<div class="c-src">${esc(p.source_name)}${p.pub_date?' · '+p.pub_date:''}${p.authors?' · '+esc(p.authors.split(',').slice(0,3).join(','))+(p.authors.split(',').length>3?' et al.':''):''}</div>`;

  // 徽章
  let badges = '';
  if(p.isNew) badges += `<span class="badge b-new">✨ NEW</span>`;
  if(p.oa_pdf_url)
    badges += `<a class="badge ${p.oaNew?'b-oanew':'b-oa'}" href="${p.oa_pdf_url}" target="_blank" rel="noopener">${p.oaNew?'🆕🟢 新開放':'🟢 免費全文'}</a>`;
  // 文獻連結：PubMed 摘要頁 + DOI 出版社原文
  if(p.url)
    badges += `<a class="badge b-link" href="${p.url}" target="_blank" rel="noopener">🔗 PubMed</a>`;
  if(p.doi)
    badges += `<a class="badge b-link" href="https://doi.org/${p.doi}" target="_blank" rel="noopener">🔗 DOI</a>`;
  for(const t of (p.tags||[]).filter(t=>!/^(neg|penalty|design|author):/.test(t)).slice(0,4))
    badges += `<span class="badge b-tag">${esc(t)}</span>`;

  body.innerHTML = title + `<div class="badges">${badges}</div>` +
    (p.abstract?`<div class="abs" id="abs-${cssId(p.item_id)}">${esc(p.abstract)}</div>`:'');

  // 動作鈕（純本地）：✅已看 | 👍😐👎 | 📖摘要
  const acts = document.createElement('div'); acts.className='acts';
  acts.appendChild(actBtn('✅ 已看','seen',!!a.seen,()=>toggleSeen(p)));
  acts.appendChild(actBtn('👍','up vote',a.vote==='up',()=>setVote(p,'up')));
  acts.appendChild(actBtn('😐','neutral vote',a.vote==='neutral',()=>setVote(p,'neutral')));
  acts.appendChild(actBtn('👎','down vote',a.vote==='down',()=>setVote(p,'down')));
  if(p.abstract){
    const ab = document.createElement('button');
    ab.className = 'act';
    ab.textContent = '📖 摘要';
    ab.onclick = () => { document.getElementById('abs-'+cssId(p.item_id)).classList.toggle('show'); };
    acts.appendChild(ab);
  }
  body.appendChild(acts);

  el.appendChild(sc); el.appendChild(body);
  return el;
}

function actBtn(label, cls, on, fn){
  const b = document.createElement('button');
  b.className = 'act ' + cls.split(' ')[0] + (on?' on':'');
  b.textContent = label;
  b.onclick = () => { fn(); render(); };
  return b;
}

function setVote(p, v){
  const a = actions[p.item_id] || (actions[p.item_id]={});
  const was = a.vote;
  a.vote = (a.vote===v) ? null : v;
  markSeen(p);
  save(LS_ACT, actions);
  if(a.vote==='up' && was!=='up') sendToCollector(p);   // 剛按讚 → 送去 Zotero
}

// 送一篇到 Apps Script 中繼（→ Zotero + Sheet）。fire-and-forget，失敗只提示。
function sendToCollector(p){
  if(!collectUrl){ toast('👍 已收藏（本機）'); return; }
  const payload = { item_id:p.item_id, doi:p.doi||'', title:p.title||'',
    authors:p.authors||'', journal:p.source_name||'', year:p.pub_date||'',
    url:p.url||('https://doi.org/'+(p.doi||'')), vote:'up' };
  // text/plain 避免 CORS preflight；no-cors fire-and-forget（Apps Script 不回 CORS 標頭）
  fetch(collectUrl, {method:'POST', mode:'no-cors',
    headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify(payload)})
    .then(()=>toast('👍 已送進 Zotero'))
    .catch(()=>toast('⚠ 匯入失敗，已存本機'));
}

let _toastT=null;
function toast(msg){
  let el=document.getElementById('toast');
  if(!el){ el=document.createElement('div'); el.id='toast'; document.body.appendChild(el); }
  el.textContent=msg; el.classList.add('show');
  clearTimeout(_toastT); _toastT=setTimeout(()=>el.classList.remove('show'), 1800);
}
function toggleSeen(p){
  const a = actions[p.item_id] || (actions[p.item_id]={});
  a.seen = !a.seen;
  save(LS_ACT, actions);
}
function markSeen(p){
  const a = actions[p.item_id] || (actions[p.item_id]={});
  if(!a.seen){ a.seen = true; save(LS_ACT, actions); }
}

function cssId(s){ return (s||'').replace(/[^a-zA-Z0-9_-]/g,'_'); }
function esc(s){ return (s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

init();
