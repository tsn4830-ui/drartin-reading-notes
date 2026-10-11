/**
 * reading-radar 投票中繼 — Google Apps Script 參考版
 * ---------------------------------------------------------------------------
 * 部署：Apps Script 專案 →「部署 / 新增部署 / 網頁應用程式」
 *   - 執行身分：我自己
 *   - 存取權：任何人（前端用 no-cors fire-and-forget 送 text/plain）
 * 部署後拿到的網址填進 site/collect.config.json 的 "url"。
 *
 * 這版做兩件事：
 *   1) 一律把每一票寫進「votes」工作表（供 train_interest.py 回訓；只需 item_id + vote）。
 *   2) 只有 vote === 'up' 才加入 Zotero（← 安全閘門，👎/😐 不會誤收藏）。
 *
 * ⚠ 若你原本已有一支會加 Zotero 的 doPost：把你「加入 Zotero」那段程式碼搬進下面
 *    addToZotero() 裡即可，其餘照這版。關鍵是 Zotero 動作務必包在 if (data.vote === 'up')。
 *
 * 前端送來的 JSON 欄位：
 *   { item_id, vote, doi, title, authors, journal, year, url, tags:[...] }
 *   vote ∈ 'up' | 'down' | 'neutral' | 'none'(取消)
 */

var SHEET_NAME = 'votes';
var HEADERS = ['timestamp', 'item_id', 'vote', 'title', 'journal', 'year', 'doi', 'tags'];

function doPost(e) {
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput('bad json');
  }

  // 1) 記票（所有票別都記）
  try {
    logVote(data);
  } catch (err) {
    // 記票失敗不影響 Zotero；靜默即可（前端是 fire-and-forget）
  }

  // 2) 只有 👍 才收藏到 Zotero
  if (data.vote === 'up') {
    try {
      addToZotero(data);
    } catch (err) {}
  }

  return ContentService.createTextOutput('ok');
}

function logVote(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
  }
  var tags = Array.isArray(data.tags) ? data.tags.join('|') : (data.tags || '');
  sh.appendRow([
    new Date(),
    data.item_id || '',
    data.vote || '',
    data.title || '',
    data.journal || '',
    data.year || '',
    data.doi || '',
    tags
  ]);
}

/**
 * 把一篇加入 Zotero。把你原本可用的 Zotero 邏輯貼進來。
 * 下面是 Zotero Web API 的最小範例（需要 ZOTERO_USER_ID / ZOTERO_API_KEY，
 * 建議存在 指令碼屬性 PropertiesService，不要寫死在原始碼）。
 */
function addToZotero(data) {
  var props = PropertiesService.getScriptProperties();
  var uid = props.getProperty('ZOTERO_USER_ID');
  var key = props.getProperty('ZOTERO_API_KEY');
  if (!uid || !key) return;   // 沒設就當沒事（只記票）

  var item = [{
    itemType: 'journalArticle',
    title: data.title || '',
    DOI: data.doi || '',
    publicationTitle: data.journal || '',
    date: data.year || '',
    url: data.url || (data.doi ? 'https://doi.org/' + data.doi : ''),
    creators: (data.authors || '').split(',').filter(String).map(function (n) {
      return { creatorType: 'author', name: n.trim() };
    })
  }];

  UrlFetchApp.fetch('https://api.zotero.org/users/' + uid + '/items', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Zotero-API-Key': key },
    payload: JSON.stringify(item),
    muteHttpExceptions: true
  });
}
