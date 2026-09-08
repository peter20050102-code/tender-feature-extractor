# 公共工程招標特徵萃取系統

從招標文件（PCCES XML 預算書、PDF 施工圖說／規範、投標須知、工程契約等 .docx/.doc/.odt）
自動萃取建物特徵（樓地板面積、鋼筋/模板/混凝土用量、樓層數、建築用途、地區係數、結構型式、基礎型式），
供後續造價預測模型使用。

## 架構

- `index.html` — 前端（純靜態頁面）。PCCES XML 用瀏覽器內建 DOMParser 精確解析數值；
  `.docx`/`.odt` 用 mammoth.js／JSZip 解析；PDF 用 pdf.js 在瀏覽器端擷取文字（施工圖說
  常常上百 MB，故文字擷取留在前端，不整包上傳到後端）；`.doc`（舊版二進位格式）瀏覽器解不動，
  丟給後端 Function 用 `word-extractor` 解析。
- `netlify/functions/process.js` — 後端 Function，兩個用途：
  1. `mode:"doc"` 解析上傳的 `.doc` 檔案文字
  2. `mode:"llm"` 代轉呼叫學校 Furen-max API（校方 API 不開放瀏覽器直接呼叫 CORS，
     必須經伺服器端轉發）。API Key 由使用者在頁面上自行輸入、每次呼叫隨請求帶入，
     Function 本身不儲存金鑰。

## 本機開發

```bash
npm install
netlify dev
```

## 部署

已連接 GitHub，push 到 `main` 分支後 Netlify 會自動重新部署。
