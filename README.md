# 📡 文獻雷達 · 老醫 / 骨鬆 / 內分泌

一個**公開、可分享**的個人文獻雷達：每天自動從 PubMed 抓「老人醫學 / 骨質疏鬆 / 內分泌新陳代謝」新論文，依研究興趣**評分排序**，推到一個 GitHub Pages 靜態網頁上滑、篩選、看免費全文。

**零維護、零費用、零後端** — 由 GitHub Actions 每天跑一次，資料存成靜態 `papers.json`，投票 / 已看只存在各訪客自己的瀏覽器。改編自 [drpwchen/paper-radar](https://github.com/drpwchen/paper-radar)（原版是私密自架版）。

---

## 特色

- 🔍 **19 個 PubMed 來源**（期刊 + 主題式搜尋），自動去重
- 🎯 **興趣評分**：GLP-1 / SGLT2 / 抗骨鬆藥 / 肌少症 … 高分浮上來，雜訊沉下去
- 🟢 **免費全文徽章**：每篇查 Unpaywall，開放取用的直接給 PDF 連結
- ✨ **NEW / 上次造訪後新增** 標記
- 📱 手機也能滑，主題開關、搜尋、排序、篩選
- 🔗 公開網址，丟連結給同事就能看

## 架構

```
GitHub Actions（每天 UTC 22:00 = 台灣 06:00 cron）
  fetch_and_score.py   19 個 PubMed feed → SQLite 去重 → interest_model 評分 → papers.json
  enrich.py            每篇 DOI → Unpaywall（免費全文判定）
        │ commit paper_radar.db + site/papers.json（保留 first_seen → NEW 徽章）
        ▼
GitHub Pages（公開靜態站）
  site/index.html + app.js + papers.json   純前端，無後端
```

## 怎麼部署（一次設定，之後全自動）

1. 把這個資料夾推到你自己的 GitHub repo（public）。
2. Repo → **Settings → Pages → Source** 選 **GitHub Actions**。
3. Repo → **Settings → Actions → General → Workflow permissions** 選 **Read and write permissions**。
4. （選用，想要 🟢 免費全文徽章才需要）Repo → **Settings → Secrets and variables → Actions → New repository secret**，
   名稱 `UNPAYWALL_EMAIL`，值填一個可用 email（Unpaywall API 只拿來識別，不寄信；**不會出現在 repo 裡**）。
5. Repo → **Actions** 頁，手動跑一次 `update-radar`（或等隔天 cron）。
6. 完成後你的站在 `https://<帳號>.github.io/<repo>/`。

> 之後每天早上自動更新，你什麼都不用做。
> 沒設 `UNPAYWALL_EMAIL` 也完全能跑，只是少了免費全文徽章。

## 怎麼客製

| 想改什麼 | 改哪裡 |
|---|---|
| 追哪些期刊 / 主題 | `config.yaml` 的 `feeds`（`[ta]` 換期刊、`term` 換主題 query） |
| 主題分組開關 | `config.yaml` 的 `topic_groups` |
| 評分權重 / 關鍵字 | `interest_model.json`（`positive` / `negative` / `design_bonus`） |
| Unpaywall 用的 email | 環境變數 `UNPAYWALL_EMAIL`（本地 `export`；CI 設成 secret，不進 repo） |
| 網站標題 / 頁尾 | `site/index.html` |

改完 push 即可，下次 Actions 會套用。

## 本地測試

```bash
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
./venv/bin/python fetch_and_score.py          # 抓 + 評分 → papers.json
UNPAYWALL_EMAIL=you@example.com ./venv/bin/python enrich.py --workers 8   # 補免費全文徽章（可省略）
cp papers.json site/papers.json
./venv/bin/python -m http.server 8791 --directory site   # 開 http://localhost:8791
```

只想快速看畫面：抓一兩個 feed 就好 —
`./venv/bin/python fetch_and_score.py --only jcem,incretin --limit 5`

## 檔案

| 檔案 | 作用 |
|---|---|
| `fetch_and_score.py` | 抓取 + 去重 + 興趣評分（核心） |
| `enrich.py` | Unpaywall 免費全文加值 |
| `config.yaml` | feed 清單 + 主題分組 + email |
| `interest_model.json` | 評分模型（關鍵字 / 權重） |
| `site/` | 靜態前端（index.html / app.js / style.css / papers.json） |
| `.github/workflows/update.yml` | 每日自動更新 + 部署 |

---

改編自 [paper-radar](https://github.com/drpwchen/paper-radar)（MIT）· 評分與抓取核心沿用原作，前端改為公開靜態版。
