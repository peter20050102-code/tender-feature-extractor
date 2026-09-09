
// ── Theme ──
function toggleTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  document.documentElement.setAttribute('data-theme', t === 'dark' ? 'light' : t === 'light' ? '' : 'dark');
  if (document.documentElement.getAttribute('data-theme') === '') document.documentElement.removeAttribute('data-theme');
}

// ── Upload ──
function onXml(inp) {
  const z = document.getElementById('zone-xml');
  const n = document.getElementById('xml-name');
  if (inp.files.length) { z.classList.add('active'); n.textContent = inp.files[0].name; }
  else { z.classList.remove('active'); n.textContent = ''; }
  checkReady();
}
function onDocs(inp) {
  const z = document.getElementById('zone-docs');
  const n = document.getElementById('docs-name');
  if (inp.files.length) { z.classList.add('active'); n.textContent = Array.from(inp.files).map(f=>f.name).join('、'); }
  else { z.classList.remove('active'); n.textContent = ''; }
  checkReady();
}
function checkReady() {
  const has = document.getElementById('xmlFile').files.length || document.getElementById('docFiles').files.length;
  document.getElementById('extractBtn').disabled = !has;
}

// ── Status ──
function setStatus(type, msg) {
  const b = document.getElementById('statusBar');
  b.className = 'status ' + type;
  b.innerHTML = type === 'loading' ? `<div class="spin"></div><span>${msg}</span>` : msg;
}

// ── PCCES XML ──
const NS = 'http://pcstd.pcc.gov.tw/2003/eTender';
function nsChild(parent, tag) {
  for (const c of (parent ? parent.children : [])) if (c.localName === tag) return c;
  return null;
}
function extractXML(txt) {
  const doc = new DOMParser().parseFromString(txt, 'text/xml');
  const g = tag => { const e = doc.getElementsByTagNameNS(NS, tag)[0]; return e ? e.textContent.trim() : null; };
  const n = tag => { const v = g(tag); return v ? parseFloat(v) : null; };
  const r = { contract_title: g('ContractTitle'), contract_location: g('ContractLocation'),
               total_amount: n('TotalAmount'), gfa_m2: n('ContractScale'),
               rebar_ton: 0, formwork_m2: 0, concrete_m3: 0 };
  for (const el of doc.getElementsByTagNameNS(NS, 'Description')) {
    const desc = el.textContent.trim();
    const p = el.parentElement; if (!p) continue;
    const qe = nsChild(p, 'Quantity'); if (!qe) continue;
    const qty = parseFloat(qe.textContent); if (isNaN(qty) || qty <= 1) continue;
    const unit = (nsChild(p, 'Unit') || {}).textContent || '';
    // 原本要求「含彎紮組立」「含組立及拆除」等精確措辭，但不同機關/標案的
    // 品項描述寫法差異很大（例如「連工帶料」「組立」而非固定措辭），太嚴格
    // 會整批漏抓。放寬成只認「鋼筋+SD+噸」「模板+M2」「混凝土+M3」的組合，
    // 搭配上面已有的 qty<=1 略過規則（排除單價/小計性質的參考項目）。
    if (desc.includes('鋼筋') && desc.includes('SD') && unit === 'T') r.rebar_ton += qty;
    else if (desc.includes('模板') && unit === 'M2') r.formwork_m2 += qty;
    else if (desc.includes('混凝土') && (desc.includes('結構') || desc.includes('預拌')) && unit === 'M3') r.concrete_m3 += qty;
  }
  return r;
}

// ── Doc reading ──
async function readDocx(file) {
  const buf = await file.arrayBuffer();
  return (await mammoth.extractRawText({ arrayBuffer: buf })).value || '';
}
async function readOdt(file) {
  const zip = await JSZip.loadAsync(file);
  const cf = zip.file('content.xml'); if (!cf) return '';
  const doc = new DOMParser().parseFromString(await cf.async('string'), 'text/xml');
  const ns = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
  return Array.from(doc.getElementsByTagNameNS(ns, 'p')).map(p=>p.textContent.trim()).filter(Boolean).join('\n');
}

// pdf.js loads as an ES module (see the <script type="module"> above); wait
// for it to announce readiness before the first PDF is parsed.
let _pdfjsReadyPromise = null;
function waitForPdfjs() {
  if (window.__pdfjsLib) return Promise.resolve(window.__pdfjsLib);
  if (!_pdfjsReadyPromise) {
    _pdfjsReadyPromise = new Promise(resolve => {
      window.addEventListener('pdfjs-ready', () => resolve(window.__pdfjsLib), { once: true });
    });
  }
  return _pdfjsReadyPromise;
}
// 施工圖說常常有幾百頁，且多半是重複的圖框/圖例；只抓前面一定頁數 +
// 一旦抓到夠多字就提早停止，避免瀏覽器端解析太久、送給 LLM 的內容也太肥大。
const PDF_MAX_PAGES = 12;
const PDF_MAX_CHARS = 4000;

// 「面積計算表」這類表格在建築圖說裡常常是 CAD 匯出的圖框內容（點陣/向量
// 線框），不是可選取的文字，pdf.js 的 getTextContent() 完全讀不到。解法：
// 先掃頁面文字找有沒有命中這些表格標題關鍵字（頁面標題本身通常還是文字），
// 命中的頁面才整頁轉成圖片、用 Tesseract.js（純前端 OCR，不需要後端/LLM）
// 讀出表格內容，附加進送給 LLM 的文字裡。掃描範圍與 OCR 頁數都設上限，避免
// 上百頁的大圖說拖垮瀏覽器。
const OCR_KEYWORDS = ['面積計算表', '面積計算書', '設計概要表', '設計概要', '樓地板面積', '面積表'];
const OCR_SCAN_MAX_PAGES = 100;
const OCR_MAX_HIT_PAGES = 2;

let _tesseractWorkerPromise = null;
function getTesseractWorker() {
  if (!_tesseractWorkerPromise) {
    _tesseractWorkerPromise = Tesseract.createWorker('chi_tra+eng');
  }
  return _tesseractWorkerPromise;
}

async function readPdf(file, onProgress) {
  const pdfjsLib = await waitForPdfjs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pageCount = Math.min(pdf.numPages, PDF_MAX_PAGES);
  let text = '';
  for (let i = 1; i <= pageCount; i++) {
    if (onProgress) onProgress('text', i, pageCount, pdf.numPages);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n';
    if (text.length >= PDF_MAX_CHARS) break;
  }
  text = text.slice(0, PDF_MAX_CHARS);

  let ocrText = '';
  let ocrPages = [];
  try {
    const scanCount = Math.min(pdf.numPages, OCR_SCAN_MAX_PAGES);
    for (let i = 1; i <= scanCount; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const t = content.items.map(it => it.str).join('');
      if (OCR_KEYWORDS.some(k => t.includes(k))) {
        ocrPages.push(i);
        if (ocrPages.length >= OCR_MAX_HIT_PAGES) break;
      }
    }
    if (ocrPages.length) {
      if (onProgress) onProgress('ocr-load', 0, ocrPages.length, pdf.numPages);
      const worker = await getTesseractWorker();
      for (const pn of ocrPages) {
        if (onProgress) onProgress('ocr', pn, ocrPages.length, pdf.numPages);
        const page = await pdf.getPage(pn);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const { data } = await worker.recognize(canvas);
        ocrText += `\n【OCR 第 ${pn} 頁表格內容】\n${(data.text || '').trim()}\n`;
      }
    }
  } catch (e) {
    console.warn('OCR 步驟失敗，略過：', e);
  }

  return {
    text: (text + ocrText).slice(0, PDF_MAX_CHARS + 3000),
    totalPages: pdf.numPages,
    readPages: pageCount,
    ocrPages,
  };
}

// .doc（舊版二進位格式）瀏覽器端解不動，丟給後端 Function（word-extractor）處理。
async function readDoc(file) {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  const base64 = btoa(binary);
  const resp = await fetch('/.netlify/functions/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'doc', name: file.name, base64 }),
  });
  if (!resp.ok) throw new Error(`.doc 解析服務錯誤 HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.warning) console.warn(data.warning);
  return data.text || '';
}

async function collectText(files) {
  const pri = ['投標須知','工程採購契約','工程概要','招標文件','施工圖說','施工規範'];
  const sorted = Array.from(files).sort((a,b) => {
    const ra = (() => { const i = pri.findIndex(k=>a.name.includes(k)); return i<0?10:i; })();
    const rb = (() => { const i = pri.findIndex(k=>b.name.includes(k)); return i<0?10:i; })();
    return ra - rb;
  });
  const parts = [];
  for (const f of sorted) {
    try {
      let t = '';
      const lower = f.name.toLowerCase();
      if (lower.endsWith('.docx')) t = await readDocx(f);
      else if (lower.endsWith('.odt')) t = await readOdt(f);
      else if (lower.endsWith('.doc')) {
        setStatus('loading', `後端解析 .doc：${f.name}…`);
        t = await readDoc(f);
      } else if (lower.endsWith('.pdf')) {
        const r = await readPdf(f, (phase, i, n, total) => {
          if (phase === 'text') {
            setStatus('loading', `讀取 PDF 文字：${f.name}（第 ${i}/${n} 頁${total>n?`，僅取前 ${n}/${total} 頁`:''}）…`);
          } else if (phase === 'ocr-load') {
            setStatus('loading', `載入 OCR 辨識引擎（首次使用需下載語言包，可能需要數十秒）…`);
          } else if (phase === 'ocr') {
            setStatus('loading', `OCR 辨識表格：${f.name}（第 ${i} 頁，命中 ${n} 頁候選）…`);
          }
        });
        t = r.text;
        if (r.ocrPages && r.ocrPages.length) window.__ocrNotes.push(`${f.name}：第 ${r.ocrPages.join('、')} 頁（OCR）`);
      }
      if (t.trim()) parts.push(`【${f.name}】\n${t}`);
    } catch(e) { console.warn('略過', f.name, e); }
  }
  return parts.join('\n\n').slice(0, 6000);
}

// ── LLM（透過後端 Function 轉發，避開 CORS、金鑰仍由使用者自行輸入）──
async function callLLM(key, text) {
  const resp = await fetch('/.netlify/functions/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'llm', apiKey: key, text }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data.result;
}

// ── Options ──
const BUILD_OPT = [
  {l:'工業 — 廠房、倉庫、工廠 (1)', v:1, k:'工業'},
  {l:'住宿 — 宿舍、公寓、旅館 (2)', v:2, k:'住宿'},
  {l:'教育商業 — 學校、活動中心、社福 (3)', v:3, k:'教育商業'},
  {l:'辦公 — 行政大樓、政府機關 (4)', v:4, k:'辦公'},
  {l:'醫療 — 醫院、診所、衛生所 (5)', v:5, k:'醫療'},
];
// 地區係數依據：中華民國產物保險商業同業公會（2025）。臺灣地區住宅類建築
// 造價參考表（114年1月1日起實施）。官方數據：台北市9,660元/m² vs 台南市
// 5,820元/m²，差距達66%，反映地區差異對造價之重要性。北部係數採台北市為
// 代表值(1.21)；官方備註：「外島地區造價比照新北市造價標準，交通運輸不
// 便地區應酌增單價。」
const REGION_OPT = [
  {l:'北部 — 台北/新北/桃園/新竹 (1.21)', v:1.21, kw:['台北','新北','桃園','新竹','基隆']},
  {l:'中部 — 台中/苗栗/彰化/南投/雲林 (1.02)', v:1.02, kw:['台中','苗栗','彰化','南投','雲林']},
  {l:'南部 — 台南/高雄/嘉義/屏東 (1.00)', v:1.00, kw:['台南','高雄','嘉義','屏東']},
  {l:'東部 — 宜蘭/花蓮/台東 (1.069)', v:1.069, kw:['宜蘭','花蓮','台東']},
];
const STRUCT_OPT = [
  {l:'RC — 鋼筋混凝土 (1)', v:1, k:'RC'},
  {l:'SRC — 鋼骨鋼筋混凝土 (2)', v:2, k:'SRC'},
  {l:'S — 純鋼骨 (3)', v:3, k:'S'},
  {l:'SC — 鋼管混凝土外殼 (4)', v:4, k:'SC'},
  {l:'CFT — 鋼管混凝土 (5)', v:5, k:'CFT'},
];
const FOUND_OPT = [
  {l:'獨立基礎 (1)', v:1}, {l:'筏式基礎 (2)', v:2},
  {l:'混合基礎 (3)', v:3}, {l:'地質改良 (4)', v:4}, {l:'樁基礎 (5)', v:5},
];

// ── Main flow ──
async function doExtract() {
  const btn = document.getElementById('extractBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spin" style="border-color:rgba(255,255,255,.3);border-top-color:#fff"></div><span>萃取中…</span>';
  document.getElementById('results').hidden = true;
  let xml = {}, llm = {};
  window.__ocrNotes = [];
  try {
    const xf = document.getElementById('xmlFile').files[0];
    const df = document.getElementById('docFiles').files;
    const key = document.getElementById('apiKey').value.trim();

    if (xf) { setStatus('loading','解析 PCCES XML…'); xml = extractXML(await xf.text()); }

    let docText = '';
    if (df.length) { docText = await collectText(df); }
    let prefix = '';
    if (xml.contract_title) prefix += `工程名稱：${xml.contract_title}\n`;
    if (xml.contract_location) prefix += `施工地點：${xml.contract_location}\n`;
    docText = prefix + docText;

    if (docText.trim() && key) {
      setStatus('loading','呼叫 Furen-max API…');
      try { llm = await callLLM(key, docText); }
      catch(e) {
        setStatus('err', `⚠ LLM 失敗：${e.message}。語意特徵請手動選擇。`);
      }
    } else if (!key) {
      setStatus('err','⚠ 未輸入 API Key，略過 LLM。請輸入後重新萃取，或手動選擇語意特徵。');
    }

    renderResults(xml, llm);
    document.getElementById('results').hidden = false;
    const sb = document.getElementById('statusBar');
    if (!sb.classList.contains('err')) {
      const ocrNote = window.__ocrNotes && window.__ocrNotes.length
        ? `　（已 OCR 讀取：${window.__ocrNotes.join('；')}）` : '';
      setStatus('ok', `✓ 萃取完成！請確認下方欄位並補齊缺漏項目。${ocrNote}`);
    }
  } catch(e) {
    setStatus('err', `萃取失敗：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>🔍</span><span>重新萃取</span>';
  }
}

// ── Render ──
function fmtNum(v, dec=2) {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (isNaN(n)) return null;
  return n.toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function mkNumField(label, value, unit, id, step='0.01', min='0') {
  const has = value !== null && value !== undefined && value !== 0;
  const cls = has ? 'field field-g' : 'field field-a';
  const badge = has ? '<span class="badge bg-g">自動</span>' : '<span class="badge bg-a">人工填入</span>';
  if (has) {
    return `<div class="${cls}">
      <div class="field-row"><span class="field-lbl">${label}</span>${badge}</div>
      <div class="field-val">${fmtNum(value)}<span class="unit">${unit}</span></div>
      <input type="hidden" id="${id}" value="${value}">
    </div>`;
  } else {
    return `<div class="${cls}">
      <div class="field-row"><span class="field-lbl">${label}</span>${badge}</div>
      <input class="f-input" type="number" id="${id}" step="${step}" min="${min}" placeholder="0" oninput="updateMetrics()">
    </div>`;
  }
}

function mkNumFieldZeroOk(label, value, unit, id) {
  const has = value !== null && value !== undefined;
  const cls = has ? 'field field-b' : 'field field-a';
  const badge = has ? '<span class="badge bg-b">LLM</span>' : '<span class="badge bg-a">人工填入</span>';
  if (has) {
    return `<div class="${cls}">
      <div class="field-row"><span class="field-lbl">${label}</span>${badge}</div>
      <div class="field-val">${value}<span class="unit">${unit}</span></div>
      <input type="hidden" id="${id}" value="${value}">
    </div>`;
  } else {
    return `<div class="${cls}">
      <div class="field-row"><span class="field-lbl">${label}</span>${badge}</div>
      <input class="f-input" type="number" id="${id}" step="1" min="0" placeholder="0" oninput="updateMetrics()">
    </div>`;
  }
}

function mkSelect(label, opts, selectedVal, id, hint) {
  const has = selectedVal !== null && selectedVal !== undefined;
  const cls = has ? 'field field-b' : 'field field-a';
  const badge = has ? '<span class="badge bg-b">LLM</span>' : '<span class="badge bg-a">人工填入</span>';
  const hintHtml = hint ? `<div class="llm-hint">${hint}</div>` : '';
  const placeholder = has ? '' : '<option value="" disabled selected>— 請選擇 —</option>';
  const options = opts.map(o => `<option value="${o.v}" ${o.v == selectedVal ? 'selected' : ''}>${o.l}</option>`).join('');
  return `<div class="${cls}">
    <div class="field-row"><span class="field-lbl">${label}</span>${badge}</div>
    ${hintHtml}
    <select class="f-select" id="${id}" onchange="updateMetrics()">${placeholder}${options}</select>
  </div>`;
}

function renderResults(xml, llm) {
  const gfa = xml.gfa_m2 || llm.gfa_m2 || null;
  document.getElementById('f-gfa').innerHTML      = mkNumField('樓地板面積', gfa, 'm²', 'inp-gfa');
  document.getElementById('f-rebar').innerHTML    = mkNumField('鋼筋用量', xml.rebar_ton||null, '噸', 'inp-rebar');
  document.getElementById('f-formwork').innerHTML = mkNumField('模板用量', xml.formwork_m2||null, 'M²', 'inp-fw');
  document.getElementById('f-concrete').innerHTML = mkNumField('混凝土用量', xml.concrete_m3||null, 'M³', 'inp-conc');

  const fa = llm.floors_above !== undefined ? llm.floors_above : null;
  const fb = llm.floors_below !== undefined ? llm.floors_below : null;
  document.getElementById('f-above').innerHTML = mkNumFieldZeroOk('地上樓層數', fa, '層', 'inp-fa');
  document.getElementById('f-below').innerHTML = mkNumFieldZeroOk('地下樓層數', fb, '層', 'inp-fb');

  const buKey = llm.building_use;
  const buOpt = BUILD_OPT.find(o=>o.k===buKey);
  document.getElementById('f-use').innerHTML = mkSelect('建築用途', BUILD_OPT, buOpt?.v||null, 'sel-use', buKey);

  const reg = llm.region || '';
  const regOpt = REGION_OPT.find(o=>o.kw.some(k=>reg.includes(k)));
  document.getElementById('f-region').innerHTML = mkSelect('地區係數', REGION_OPT, regOpt?.v||null, 'sel-region', reg||null);

  const stKey = llm.structure_type;
  const stOpt = STRUCT_OPT.find(o=>o.k===stKey);
  document.getElementById('f-struct').innerHTML = mkSelect('結構型式', STRUCT_OPT, stOpt?.v||null, 'sel-struct', stKey);
  document.getElementById('f-found').innerHTML  = mkSelect('基礎型式（需查結構圖說）', FOUND_OPT, null, 'sel-found', null);

  const ib = document.getElementById('infoBar');
  if (xml.contract_title || xml.total_amount) {
    ib.hidden = false;
    ib.innerHTML =
      (xml.contract_title ? `<div><strong>工程名稱：</strong>${xml.contract_title}</div>` : '') +
      (xml.total_amount   ? `<div><strong>預算金額：</strong>${xml.total_amount.toLocaleString()} 元</div>` : '') +
      (xml.contract_location ? `<div><strong>施工地點：</strong>${xml.contract_location}</div>` : '');
  } else { ib.hidden = true; }

  updateMetrics();
}

// ── Get value ──
function gv(id, type='float') {
  const el = document.getElementById(id); if (!el) return null;
  const v = el.value; if (v === '' || v === undefined) return null;
  if (type === 'float') { const n = parseFloat(v); return isNaN(n) ? null : n; }
  if (type === 'int')   { const n = parseInt(v);   return isNaN(n) ? null : n; }
  return v;
}

function getFeatures() {
  return {
    '樓地板面積 (m²)': gv('inp-gfa'),
    '鋼筋用量 (噸)':   gv('inp-rebar'),
    '模板用量 (M²)':   gv('inp-fw'),
    '混凝土用量 (M³)': gv('inp-conc'),
    '地上樓層':         gv('inp-fa','int'),
    '地下樓層':         gv('inp-fb','int'),
    '建築用途代碼':     gv('sel-use','int'),
    '結構型式代碼':     gv('sel-struct','int'),
    '地區係數':         gv('sel-region'),
    '基礎型式代碼':     gv('sel-found','int'),
  };
}

// ── Metrics ──
const META = [
  {k:'樓地板面積 (m²)', u:'m²'}, {k:'鋼筋用量 (噸)', u:'噸'},
  {k:'模板用量 (M²)',   u:'M²'}, {k:'混凝土用量 (M³)', u:'M³'},
  {k:'地上樓層', u:'層'},        {k:'地下樓層', u:'層'},
  {k:'建築用途代碼', u:''},      {k:'結構型式代碼', u:''},
  {k:'地區係數', u:''},          {k:'基礎型式代碼', u:''},
];
function updateMetrics() {
  const feats = getFeatures();
  const grid = document.getElementById('metricGrid');
  grid.innerHTML = '';
  for (const {k,u} of META) {
    const v = feats[k];
    const miss = v === null || v === undefined;
    const display = miss ? '—' : (typeof v==='number' && !Number.isInteger(v)) ? v.toFixed(2) : String(v);
    const tile = document.createElement('div');
    tile.className = 'm-tile' + (miss ? ' missing' : '');
    tile.innerHTML = `<div class="m-lbl">${k}</div>
      <div class="m-val${miss?' empty':''}">${display}</div>
      ${u?`<div class="m-unit">${u}</div>`:''}`;
    grid.appendChild(tile);
  }
}

// ── Download ──
function downloadJSON() {
  const feats = getFeatures();
  const clean = Object.fromEntries(Object.entries(feats).map(([k,v]) =>
    [k, v !== null && typeof v === 'number' ? +v.toFixed(4) : v]
  ));
  const blob = new Blob([JSON.stringify(clean, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: 'features.json' });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
