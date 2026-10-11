#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""reading-radar 興趣模型回訓：用「作者本人」的投票微調 interest_model.json 權重。

資料源（擇一，優先序）：
  1. --votes-csv URL / 環境變數 VOTES_CSV_URL：Google Sheet「發布到網路」的 CSV。
     只需兩欄——欄名含 item / vote 即可（大小寫、其他欄不拘）。vote 值：up / down / neutral。
  2. 本地 training_log.jsonl：每行 {"item_id": "...", "vote": "up"}。
  都沒有 → 乾淨跳過、exit 0（CI 不會壞）。

為什麼投票只要 item_id+vote：每篇論文的 tags 以 paper_radar.db 為權威來源，這裡 join 取回，
前端/表單傳什麼都不影響訓練正確性。

演算法（穩定、冪等——重跑同資料結果不漂移）：
  * 同一 item_id 取「最後一票」（表單/試算表按時間；沒時間欄則取最後一列）→ 支援改票/取消。
  * 每個「正向 tag」：net = up - down；support = up + down。
  * delta = sign(net) * min(MAX_STEP, ceil(|net| / VOTES_PER_STEP))
  * new_weight = clamp(base_weight + delta, 1, 5)
    base_weight = 第一次跑時把當下 weight 存成「錨」，之後永不變 → 重跑可重現、不會滾雪球。
  * 只動 support >= MIN_SUPPORT 的正向 tag。
  * 負向 tag（neg:/penalty:/design:/author:）只「報告」不自動改——避免子字串誤命中把權重帶歪。

用法：
    python train_interest.py [--model interest_model.json] [--db paper_radar.db]
        [--votes-csv URL] [--log training_log.jsonl] [--dry-run]
        [--votes-per-step 3] [--max-step 2] [--min-support 3]
"""
import argparse, csv, io, json, math, os, sqlite3, sys, urllib.request
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
UA = "Mozilla/5.0 (reading-radar)"
WMIN, WMAX = 1, 5


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def norm_vote(v):
    v = (v or "").strip().lower()
    if v in ("up", "1", "👍", "like", "yes"):
        return "up"
    if v in ("down", "-1", "👎", "dislike", "no"):
        return "down"
    if v in ("neutral", "0", "😐", "meh"):
        return "neutral"
    return ""   # 空 / 取消 / 不認得 → 視為沒投


def votes_from_csv(url):
    """回傳 [(item_id, vote), ...]，按出現順序（後者覆蓋前者）。"""
    text = http_get(url)
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        return []
    header = [h.strip().lower() for h in rows[0]]

    def col(*names):
        for i, h in enumerate(header):
            if any(n in h for n in names):
                return i
        return -1

    ci, cv = col("item", "id"), col("vote")
    if ci < 0 or cv < 0:
        print(f"⚠ CSV 找不到 item/vote 欄（表頭={header}）→ 跳過")
        return []
    out = []
    for r in rows[1:]:
        if len(r) <= max(ci, cv):
            continue
        iid, vote = r[ci].strip(), norm_vote(r[cv])
        if iid and vote:
            out.append((iid, vote))
    return out


def votes_from_log(path):
    out = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        iid, vote = (o.get("item_id") or "").strip(), norm_vote(o.get("vote"))
        if iid and vote:
            out.append((iid, vote))
    return out


def latest_per_item(pairs):
    """後出現者覆蓋 → 每 item_id 只留最後一票。"""
    last = {}
    for iid, vote in pairs:
        last[iid] = vote
    return last


def tags_for_items(db, item_ids):
    con = sqlite3.connect(db)
    m = {}
    q = "SELECT item_id, tags FROM papers WHERE item_id IN ({})"
    ids = list(item_ids)
    for i in range(0, len(ids), 400):   # SQLite 變數上限保守分批
        chunk = ids[i:i + 400]
        ph = ",".join("?" * len(chunk))
        for iid, tags in con.execute(q.format(ph), chunk):
            try:
                m[iid] = json.loads(tags or "[]")
            except json.JSONDecodeError:
                m[iid] = []
    con.close()
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(SCRIPT_DIR / "interest_model.json"))
    ap.add_argument("--db", default=str(SCRIPT_DIR / "paper_radar.db"))
    ap.add_argument("--votes-csv", default=os.environ.get("VOTES_CSV_URL", "").strip())
    ap.add_argument("--log", default=str(SCRIPT_DIR / "training_log.jsonl"))
    ap.add_argument("--votes-per-step", type=int, default=3)
    ap.add_argument("--max-step", type=int, default=2)
    ap.add_argument("--min-support", type=int, default=3)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    # 1) 取投票
    pairs = []
    if args.votes_csv:
        try:
            pairs = votes_from_csv(args.votes_csv)
            print(f"CSV 投票列：{len(pairs)}")
        except Exception as e:
            print(f"⚠ 讀 VOTES_CSV 失敗（{e}）→ 改試本地 log")
    if not pairs and Path(args.log).exists():
        pairs = votes_from_log(args.log)
        print(f"本地 log 投票列：{len(pairs)}")
    if not pairs:
        print("沒有任何投票資料 → 跳過訓練（模型不變）。")
        return

    votes = latest_per_item(pairs)                    # item_id -> up/down/neutral
    # 落地一份快照，方便 CI commit / 除錯（可重現）
    if not args.dry_run:
        with open(args.log, "w", encoding="utf-8") as f:
            for iid, v in votes.items():
                f.write(json.dumps({"item_id": iid, "vote": v}, ensure_ascii=False) + "\n")

    # 2) join tags
    tag_map = tags_for_items(args.db, votes.keys())
    missing = [i for i in votes if i not in tag_map]
    if missing:
        print(f"⚠ {len(missing)} 篇投票在 DB 找不到（可能已被清或跨庫）→ 略過那些")

    # 3) 每個「正向 tag」聚合 up/down（只算 DB 有的正向 tag；neg:/design: 等不計）
    model = json.load(open(args.model, encoding="utf-8"))
    pos_tags = {g["tag"] for g in model.get("positive", [])}
    from collections import defaultdict
    agg = defaultdict(lambda: [0, 0, 0])   # tag -> [up, down, neutral]
    for iid, v in votes.items():
        for t in tag_map.get(iid, []):
            if t in pos_tags:
                agg[t][{"up": 0, "down": 1, "neutral": 2}[v]] += 1

    # 4) 算新權重（穩定/冪等）
    changes, reports = [], []
    for g in model.get("positive", []):
        t = g["tag"]
        up, down, neu = agg.get(t, [0, 0, 0])
        support = up + down
        base = g.get("base_weight")
        if base is None:                          # 第一次見到 → 定錨
            base = g["weight"]
            g["base_weight"] = base
        if support < args.min_support:
            continue
        net = up - down
        step = int(math.copysign(1, net)) * min(args.max_step,
                                                math.ceil(abs(net) / args.votes_per_step)) if net else 0
        new_w = max(WMIN, min(WMAX, base + step))
        if new_w != g["weight"]:
            changes.append((t, g["weight"], new_w, up, down))
            g["weight"] = new_w
        reports.append(f"  {t}: up={up} down={down} → base={base} step={step:+d} weight={new_w}")

    # 負向只報告
    neg_report = []
    for g in model.get("negative", []):
        nt = f"neg:{g['tag']}"
        up, down, neu = agg.get(nt, [0, 0, 0])   # 通常 0，因負向 tag 不在 pos_tags；保留擴充位
        if up or down:
            neg_report.append(f"  (負向,人工)neg:{g['tag']}: up={up} down={down}")

    print("=" * 60)
    print("投票聚合（達門檻的正向 tag）：")
    print("\n".join(reports) or "  （無達門檻 tag）")
    if neg_report:
        print("負向 tag 訊號（僅供人工參考，不自動改）：")
        print("\n".join(neg_report))

    if not changes:
        print("→ 沒有權重需要調整。")
        # 仍寫回：可能新加了 base_weight 錨（冪等）
    if args.dry_run:
        print("[dry-run] 不寫檔。變更：", changes)
        return

    model["updated"] = datetime.now().strftime("%Y-%m-%d")
    Path(args.model + ".bak-train").write_text(
        json.dumps(json.load(open(args.model, encoding="utf-8")), ensure_ascii=False, indent=2),
        encoding="utf-8")
    json.dump(model, open(args.model, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    if changes:
        print(f"✓ 調整 {len(changes)} 個 tag 權重 → {args.model}")
        for t, o, n, u, d in changes:
            print(f"    {t}: {o} → {n}  (up={u} down={d})")
    else:
        print(f"✓ 模型寫回（僅錨定 base_weight，權重未變）")


if __name__ == "__main__":
    main()
