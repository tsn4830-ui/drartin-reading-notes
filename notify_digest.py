#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""reading-radar 每日摘要推播（ntfy）。

流程：讀 paper_radar.db → 挑「今天新增(first_seen==today) 且 score>=recommend」的論文
     → 扣掉 .digest_state.json 記過的（跨次去重，避免同日手動重跑或隔日再吵）
     → POST 到 ntfy（UTF-8 JSON publish，標題/內文皆可中文）→ 把這批 item_id 記進 state。

設計原則：
  * 純標準庫，不加相依。
  * 環境變數沒設好就「乾淨跳過、exit 0」，永不弄壞 CI 每日更新。
  * enrich 之後跑，所以能讀到 oa_pdf_url 標 🟢。

環境變數：
  NTFY_URL    必填。完整 topic 端點，例：https://ntfy.sh/drartin-radar-7x9k2
              未設 → 直接跳過（視為未啟用推播）。
  NTFY_TOKEN  選填。自架 ntfy 或 reserved topic 才需要（Bearer）。ntfy.sh 隨機 topic 免。
  SITE_URL    選填。推播點一下要開的網址，預設 GitHub Pages 站。

用法：
    python notify_digest.py [--db paper_radar.db] [--model interest_model.json]
                            [--state .digest_state.json] [--max 12] [--dry-run]
"""
import argparse, json, os, sqlite3, sys, urllib.parse, urllib.request
from datetime import date
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
DEFAULT_SITE = "https://tsn4830-ui.github.io/drartin-reading-notes/"
UA = "Mozilla/5.0 (reading-radar)"


def load_state(path):
    try:
        return set(json.load(open(path, encoding="utf-8")).get("notified", []))
    except Exception:
        return set()


def save_state(path, notified):
    # 只留最近 2000 筆，避免 state 無限膨脹
    keep = list(notified)[-2000:]
    json.dump({"notified": keep}, open(path, "w", encoding="utf-8"),
              ensure_ascii=False, indent=0)


def pick_papers(db, recommend, today, already):
    con = sqlite3.connect(db)
    rows = con.execute(
        """SELECT item_id, title, score, source_name, oa_pdf_url, doi
           FROM papers
           WHERE first_seen = ? AND score >= ? AND category != 'skipped'
           ORDER BY score DESC, source_name ASC""",
        (today, recommend)).fetchall()
    con.close()
    cols = ["item_id", "title", "score", "source_name", "oa_pdf_url", "doi"]
    return [dict(zip(cols, r)) for r in rows if r[0] not in already]


def build_message(papers, maxn):
    lines = []
    for p in papers[:maxn]:
        badge = "🟢" if p["oa_pdf_url"] else "·"
        t = p["title"]
        if len(t) > 64:
            t = t[:63] + "…"
        lines.append(f"{badge} [{p['score']}] {t}\n   {p['source_name']}")
    extra = len(papers) - maxn
    if extra > 0:
        lines.append(f"\n…另有 {extra} 篇（點開看全部）")
    return "\n".join(lines)


def post_ntfy(url, token, title, message, click, dry):
    # 拆 base/topic 走 JSON publish：中文標題/內文最穩（header 帶非 ASCII 會出包）
    u = urllib.parse.urlsplit(url)
    topic = u.path.strip("/")
    base = f"{u.scheme}://{u.netloc}"
    if not topic:
        print("⚠ NTFY_URL 沒有 topic 路徑，跳過：", url)
        return False
    body = json.dumps({
        "topic": topic, "title": title, "message": message,
        "tags": ["books"], "click": click, "priority": 3,
    }, ensure_ascii=False).encode("utf-8")
    if dry:
        print("--- DRY RUN ---")
        print("POST", base, "topic=", topic)
        print(title)
        print(message)
        return True
    headers = {"Content-Type": "application/json; charset=utf-8", "User-Agent": UA}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base, data=body, method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        r.read()
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(SCRIPT_DIR / "paper_radar.db"))
    ap.add_argument("--model", default=str(SCRIPT_DIR / "interest_model.json"))
    ap.add_argument("--state", default=str(SCRIPT_DIR / ".digest_state.json"))
    ap.add_argument("--max", type=int, default=12)
    ap.add_argument("--dry-run", action="store_true", help="不真的發，印出來看")
    args = ap.parse_args()

    url = os.environ.get("NTFY_URL", "").strip()
    if not url and not args.dry_run:
        print("NTFY_URL 未設 → 跳過推播（未啟用）。")
        return
    token = os.environ.get("NTFY_TOKEN", "").strip()
    site = os.environ.get("SITE_URL", "").strip() or DEFAULT_SITE

    model = json.load(open(args.model, encoding="utf-8"))
    recommend = model.get("thresholds", {}).get("recommend", 3)
    today = date.today().isoformat()

    already = load_state(args.state)
    papers = pick_papers(args.db, recommend, today, already)
    if not papers:
        print(f"今天沒有 score>={recommend} 的新論文（或都通知過了）→ 不發。")
        return

    title = f"📚 今日新高分文獻 {len(papers)} 篇"
    message = build_message(papers, args.max)
    ok = post_ntfy(url or "https://ntfy.sh/_dryrun", token, title, message, site, args.dry_run)
    if ok and not args.dry_run:
        for p in papers:
            already.add(p["item_id"])
        save_state(args.state, already)
        print(f"✓ 已推播 {len(papers)} 篇，state 更新 → {args.state}")


if __name__ == "__main__":
    main()
