/**
 * 阿婷醫師的讀書筆記 — 按讚即時匯入 Zotero 的中繼（Google Apps Script Web App）
 * ---------------------------------------------------------------------------
 * 收到網站送來的一篇論文（👍）→ ①寫進 Zotero 書庫 ②記一列到 Google Sheet（去重）。
 * Zotero 金鑰放在「指令碼屬性」（私密），不會出現在公開網站/repo。
 *
 * === 一次性設定（3 步）===
 * 1. 到 https://www.zotero.org/settings/keys → Create new private key
 *    - 勾「Allow write access」→ 建立 → 複製那串金鑰
 *    - 同頁上方看到你的 userID（純數字）
 * 2. script.google.com → 新專案 → 貼上這整份 → 專案設定(⚙️齒輪) → 指令碼屬性 新增：
 *      ZOTERO_API_KEY = 你的金鑰
 *      ZOTERO_USER_ID = 你的數字 userID
 *      ZOTERO_COLLECTION = （選填）某個收藏夾的 key，想全丟進特定資料夾才填；留空=書庫根目錄
 * 3. 部署 → 新增部署 → 類型「網頁應用程式」→ 執行身分：我自己；誰可存取：**任何人**
 *      → 部署 → 複製「網頁應用程式」網址（https://script.google.com/macros/s/..../exec）
 *    把這個網址填進網站的 site/collect.config.json 的 "url"。
 */

// 收讚 → 加 Zotero + 記 Sheet
function doPost(e) {
  try {
    var p = JSON.parse(e.postData.contents);      // {doi,title,authors,journal,year,url,vote,item_id}
    if (!p || p.vote !== 'up') return _ok('ignored'); // 只處理按讚；收回讚不動作
    var doi = (p.doi || '').trim().toLowerCase();
    var sheet = _sheet();

    // 去重：這張 Sheet 已經有這個 DOI（或 item_id）就不重複加
    var key = doi || (p.item_id || '').toLowerCase();
    if (key && _seen(sheet, key)) return _ok('dup');

    var zres = _addToZotero(p);                    // 寫進 Zotero
    sheet.appendRow([new Date(), p.title || '', p.journal || '', p.year || '',
                     doi, p.url || '', key, zres.ok ? 'added' : ('zotero_fail:' + zres.msg)]);
    return _ok(zres.ok ? 'added' : 'sheet_only');
  } catch (err) {
    return _ok('error:' + err);
  }
}

function _addToZotero(p) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('ZOTERO_API_KEY');
  var userId = props.getProperty('ZOTERO_USER_ID');
  var coll   = props.getProperty('ZOTERO_COLLECTION');
  if (!apiKey || !userId) return { ok: false, msg: 'no_key' };

  var item = {
    itemType: 'journalArticle',
    title: p.title || '',
    creators: _creators(p.authors),
    publicationTitle: p.journal || '',
    date: p.year || '',
    DOI: (p.doi || '').replace(/^https?:\/\/doi\.org\//i, ''),
    url: p.url || '',
    tags: [{ tag: '讀書筆記' }, { tag: '按讚匯入' }]
  };
  if (coll) item.collections = [coll];

  var resp = UrlFetchApp.fetch('https://api.zotero.org/users/' + userId + '/items', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Zotero-API-Key': apiKey },
    payload: JSON.stringify([item]),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  return (code === 200 || code === 201)
    ? { ok: true, msg: 'ok' }
    : { ok: false, msg: code + ':' + resp.getContentText().slice(0, 120) };
}

// "Toussirot E, Compagne C, ... et al." → Zotero creators
function _creators(authors) {
  if (!authors) return [];
  return String(authors).replace(/\bet al\.?/i, '').split(',')
    .map(function (a) { return a.trim(); }).filter(String)
    .slice(0, 30)
    .map(function (a) {
      var m = a.match(/^(.+?)\s+([A-Za-z\-]{1,5})$/);   // 姓 + 名字縮寫
      return m ? { creatorType: 'author', lastName: m[1], firstName: m[2] }
               : { creatorType: 'author', name: a };
    });
}

function _sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {   // 若腳本沒綁試算表：自動建一份並記住
    var id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
    if (id) { ss = SpreadsheetApp.openById(id); }
    else {
      ss = SpreadsheetApp.create('讀書筆記 · 按讚收藏');
      PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
    }
  }
  var sh = ss.getSheets()[0];
  if (sh.getLastRow() === 0)
    sh.appendRow(['時間', '標題', '期刊', '年', 'DOI', '連結', 'key', '狀態']);
  return sh;
}

function _seen(sheet, key) {
  if (sheet.getLastRow() < 2) return false;
  var col = sheet.getRange(2, 7, sheet.getLastRow() - 1, 1).getValues(); // 第7欄 key
  for (var i = 0; i < col.length; i++) if (String(col[i][0]).toLowerCase() === key) return true;
  return false;
}

function _ok(msg) {
  return ContentService.createTextOutput(JSON.stringify({ status: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}
