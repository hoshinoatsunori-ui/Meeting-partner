/**
 * Phase 0 / 検証項目 3・8: observe.ts の記録を解析する。
 *
 *   npm run analyze -- logs/<日時>                      … 要素の種類ごとの一覧（字幕がどれかを探す）
 *   npm run analyze -- logs/<日時> --path "<文字列>"     … その path を含む要素の書き換わり方を詳しく見る
 *
 * 2つ目の出力で分かること:
 *   - 字幕1ブロックが何回・どう書き換わるか（追記 / 途中の書き換え / 短くなる）
 *   - 更新間隔の分布 → 「N 秒更新が無ければ確定」の N を決める材料
 *   - ブロックの寿命（最初の表示から最後の更新まで）
 */
import fs from "node:fs";
import path from "node:path";
import type { MutationRecordLite } from "./inject.js";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const pathIdx = args.indexOf("--path");
const pathFilter = pathIdx >= 0 ? args[pathIdx + 1] : undefined;
if (!dir) {
  console.error('使い方: npm run analyze -- logs/<日時> [--path "<path の一部>"]');
  process.exit(1);
}

const records: MutationRecordLite[] = readJsonl(path.join(dir, "mutations.jsonl"));
if (records.length === 0) {
  console.log("記録が0件です。");
  process.exit(0);
}
const t0 = records[0].t;

if (!pathFilter) overview();
else detail(pathFilter);
printMetrics();

// ---------------------------------------------------------------------------

/** path ごとの件数・要素数・例文。字幕らしい path を探すための一覧 */
function overview() {
  const byPath = new Map<string, { count: number; ids: Set<number>; sample: string }>();
  for (const r of records) {
    const g = byPath.get(r.path) ?? { count: 0, ids: new Set(), sample: "" };
    g.count++;
    g.ids.add(r.id);
    g.sample = r.text;
    byPath.set(r.path, g);
  }
  const rows = [...byPath.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 20);
  console.log(`記録 ${records.length} 件 / path ${byPath.size} 種類（上位20件）\n`);
  for (const [p, g] of rows) {
    console.log(`■ 更新 ${g.count} 回 / 要素 ${g.ids.size} 個`);
    console.log(`  path: ${p}`);
    console.log(`  例  : ${oneLine(g.sample, 80)}\n`);
  }
  console.log('字幕らしい path が見つかったら、その一部を --path "..." に指定して詳細を見てください。');
}

/** 指定 path の要素ごとの書き換わり履歴と統計 */
function detail(filter: string) {
  const target = records.filter((r) => r.path.includes(filter));
  if (target.length === 0) {
    console.log(`path に "${filter}" を含む記録はありません。`);
    return;
  }
  const byId = new Map<number, MutationRecordLite[]>();
  for (const r of target) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);

  const gaps: number[] = [];
  const lifetimes: number[] = [];
  const kinds = { append: 0, rewrite: 0, shrink: 0 };

  console.log(`対象 ${target.length} 件 / 要素 ${byId.size} 個\n`);
  let shown = 0;
  for (const [id, list] of byId) {
    lifetimes.push(list[list.length - 1].t - list[0].t);
    if (shown < 10) console.log(`--- 要素 #${id}（更新 ${list.length} 回）`);
    for (let i = 0; i < list.length; i++) {
      const cur = list[i];
      let kind = "new";
      if (i > 0) {
        const prev = list[i - 1].text;
        gaps.push(cur.t - list[i - 1].t);
        if (cur.text.startsWith(prev)) kind = "append";
        else if (cur.text.length < prev.length) kind = "shrink";
        else kind = "rewrite";
        kinds[kind as keyof typeof kinds]++;
      }
      if (shown < 10) {
        const sec = ((cur.t - t0) / 1000).toFixed(1).padStart(7);
        console.log(`${sec}s  ${kind.padEnd(7)} ${oneLine(cur.text, 100)}`);
      }
    }
    shown++;
  }
  if (byId.size > 10) console.log(`\n（残り ${byId.size - 10} 要素は省略）`);

  console.log("\n=== 統計 ===");
  console.log(`変化の種類: 追記 ${kinds.append} / 書き換え ${kinds.rewrite} / 短縮 ${kinds.shrink}`);
  console.log(`更新間隔(ms): ${percentiles(gaps)}`);
  console.log(`ブロック寿命(ms): ${percentiles(lifetimes)}`);
  console.log("→ 更新間隔の p90〜p99 あたりが「この時間更新が無ければ確定」の目安になる。");
}

/** events.jsonl のメモリ・CPU 計測値（検証項目 8） */
function printMetrics() {
  const file = path.join(dir!, "events.jsonl");
  if (!fs.existsSync(file)) return;
  const metrics = readJsonl<{ t: number; type: string; browserRssMB?: number; jsHeapUsedMB?: number }>(file)
    .filter((e) => e.type === "metrics");
  if (metrics.length === 0) return;
  console.log("\n=== リソース（60秒ごと）===");
  for (const m of metrics) {
    const min = ((m.t - metrics[0].t) / 60000).toFixed(0).padStart(4);
    console.log(`${min}分  Chrome合計RSS ${m.browserRssMB ?? "-"} MB / JSヒープ ${m.jsHeapUsedMB} MB`);
  }
}

// ---------------------------------------------------------------------------

function readJsonl<T = MutationRecordLite>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

function oneLine(s: string, max: number) {
  const t = s.replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function percentiles(xs: number[]) {
  if (xs.length === 0) return "データなし";
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `n=${s.length} p50=${q(0.5)} p90=${q(0.9)} p99=${q(0.99)} max=${s[s.length - 1]}`;
}
