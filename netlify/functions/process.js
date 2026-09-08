// Netlify Function: server-side helper for the 招標特徵萃取 tool.
//
// mode "doc"  -> extract plain text from a legacy .doc file (base64), using
//                word-extractor (pure Node, can't run in the browser).
// mode "llm"  -> proxy a chat-completion call to the school's Furen-max API
//                server-side, so the browser never hits it directly (their
//                endpoint doesn't send CORS headers for browser fetch()).
//
// The user's own API key is passed through from the frontend on every call
// (per their choice: keep it client-entered, just avoid CORS) — this
// function never stores or reuses a key of its own.

const WordExtractor = require('word-extractor');

const FUREN_URL = 'https://www.iai.nkust.edu.tw/aihub/v1/chat/completions';

const SYS = `你是台灣公共工程招標文件分析專家，熟悉建築法規、PCCES 系統與施工術語。
請從文件節錄中萃取建物特徵。規則：
1. 嚴格以 JSON 格式回覆，不加說明。
2. 無法判斷的欄位填 null，不捏造。
3. 建築用途：工業(廠房/倉庫) 住宿(宿舍/旅館) 教育商業(學校/活動中心/社福機構) 辦公(行政大樓) 醫療(醫院/診所)
4. 結構型式縮寫：RC SRC S SC CFT`;

const UTPL = `請萃取以下招標文件的建物特徵，回傳 JSON：
{"building_use":"工業|住宿|教育商業|辦公|醫療 擇一或null","floors_above":整數或null,"floors_below":整數或null,"gfa_m2":數字或null,"structure_type":"RC|SRC|S|SC|CFT或null","region":"縣市名稱或null"}
招標文件節錄：---\n`;

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

async function handleDoc(payload) {
  const { name, base64 } = payload;
  if (!base64) return json(400, { error: '缺少檔案內容' });
  const buf = Buffer.from(base64, 'base64');
  const extractor = new WordExtractor();
  try {
    const doc = await extractor.extract(buf);
    const text = [doc.getBody(), doc.getFootnotes(), doc.getEndnotes()]
      .filter(Boolean).join('\n').trim();
    return json(200, { name, text });
  } catch (e) {
    return json(200, { name, text: '', warning: `.doc 解析失敗：${e.message}` });
  }
}

async function handleLlm(payload) {
  const { apiKey, text } = payload;
  if (!apiKey) return json(400, { error: '缺少 API Key' });
  if (!text || !text.trim()) return json(400, { error: '缺少要分析的文字內容' });

  let resp;
  try {
    resp = await fetch(FUREN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'Furen-max',
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: UTPL + text + '\n---' },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 800,
      }),
    });
  } catch (e) {
    return json(502, { error: `連線 Furen-max 失敗：${e.message}` });
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    return json(resp.status, { error: `Furen-max HTTP ${resp.status}`, detail: detail.slice(0, 500) });
  }

  const data = await resp.json();
  let raw = (data.choices && data.choices[0] && data.choices[0].message.content) || '';
  raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const finishReason = data.choices && data.choices[0] && data.choices[0].finish_reason;
  console.log('[llm] textLen=%d finish_reason=%s rawLen=%d raw=%s',
    (text || '').length, finishReason, raw.length, raw.slice(0, 1500));

  try {
    return json(200, { result: JSON.parse(raw) });
  } catch (firstErr) {
    let fixed = raw.trimEnd();
    fixed = fixed.replace(/:\s*"[^"]*$/, ': null');
    fixed = fixed.replace(/,\s*$/, '');
    const opens = (fixed.match(/{/g) || []).length;
    const closes = (fixed.match(/}/g) || []).length;
    fixed += '}'.repeat(Math.max(0, opens - closes));
    try {
      return json(200, { result: JSON.parse(fixed) });
    } catch (secondErr) {
      // 模型偶爾會把 JSON 的 key 寫壞（例如混進雜訊字元），但值本身通常還在、
      // 順序也還是照 prompt 定義的欄位順序。與其整包放棄，不如不管 key 對不
      // 對，照出現順序把值一個個抓出來對應回我們自己的欄位名稱。
      const FIELD_ORDER = ['building_use', 'floors_above', 'floors_below', 'gfa_m2', 'structure_type', 'region'];
      const valueRe = /:\s*("(?:[^"\\]|\\.)*"|null|-?\d+(?:\.\d+)?)/g;
      const values = [];
      let m;
      while ((m = valueRe.exec(raw)) !== null) values.push(m[1]);
      if (values.length >= 3) {
        const parsed = {};
        FIELD_ORDER.forEach((key, i) => {
          if (i >= values.length) return;
          let v = values[i];
          if (v === 'null') parsed[key] = null;
          else if (v.startsWith('"')) parsed[key] = v.slice(1, -1);
          else parsed[key] = parseFloat(v);
        });
        // building_use 開頭那段有時被模型寫得特別亂（連值都跑到引號外面），
        // 光靠位置抓值救不回來；用類別關鍵字直接在全文找一次做二次確認。
        const BUILD_KEYS = ['工業', '住宿', '教育商業', '辦公', '醫療'];
        if (!BUILD_KEYS.includes(parsed.building_use)) {
          const hit = BUILD_KEYS.find(k => raw.includes(k));
          if (hit) parsed.building_use = hit;
        }
        console.log('[llm] fell back to positional parse:', JSON.stringify(parsed));
        return json(200, { result: parsed, warning: '模型回覆的 JSON 格式有誤，已用備援方式依欄位順序解析' });
      }
      return json(502, { error: `模型回覆非合法 JSON：${firstErr.message}`, raw: raw.slice(0, 1000) });
    }
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method Not Allowed' });
  }
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: '請求格式錯誤（非合法 JSON）' });
  }

  if (payload.mode === 'doc') return handleDoc(payload);
  if (payload.mode === 'llm') return handleLlm(payload);
  return json(400, { error: 'mode 需為 "doc" 或 "llm"' });
};
