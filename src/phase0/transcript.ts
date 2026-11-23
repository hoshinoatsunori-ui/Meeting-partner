/**
 * Phase 0 / 検証項目 4 の準備: observe.ts の記録（mutations.jsonl）を、確定処理（PLAN.md §4.2）に通して
 * 発話ログ（話者・時刻・本文）に変換する。
 *
 *   npm run transcript -- logs/<日時> [--finalize-ms 7000]
 *
 * 出力: logs/<日時>/transcript.jsonl（確定した発話。revision は置き換え済み）
 *       logs/<日時>/transcript.md   （読む用）
 *
 * 記録からの復元には限界がある（本番は src/core/captions/dom.ts で画面から直接読む）:
 * - 話者名は、ブロックが現れた時と同じバッチで記録された名前の要素から推定する。
 *   古い記録は日本語を含まない名前（"test" など）を記録していないので、その話者は "?" になる。
 */
import fs from "node:fs";
import path from "node:path";
import type { MutationRecordLite } from "./inject.js";
import { CaptionFinalizer, type Utterance } from "../core/captions/finalizer.js";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const msIdx = args.indexOf("--finalize-ms");
const finalizeAfterMs = msIdx >= 0 ? Number(args[msIdx + 1]) : 7_000;
if (!dir) {
  console.error("使い方: npm run transcript -- logs/<日時> [--finalize-ms 7000]");
  process.exit(1);
}

const records: MutationRecordLite[] = fs
  .readFileSync(path.join(dir, "mutations.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// 字幕 region の直下: region > div(ブロック) > div(名前の行 / 本文)、名前は region > div > div > div > span
const REGION = "aria-label=字幕]";
const isBlockChild = (p: string) => p.endsWith(`${REGION} > div > div`);
const isNameSpan = (p: string) => p.endsWith(`${REGION} > div > div > div > span`);

// バッチ（同じ時刻 t）ごとの名前
const namesAt = new Map<number, string[]>();
for (const r of records) {
  if (isNameSpan(r.path)) namesAt.set(r.t, [...(namesAt.get(r.t) ?? []), r.text]);
}

const byKey = new Map<string, Utterance>();
const order: string[] = [];
const finalizer = new CaptionFinalizer(
  (u) => {
    const key = `${u.blockId}@${u.offset}`;
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, u);
  },
  { finalizeAfterMs },
);

const speakerOf = new Map<number, string>();
const lastTextOf = new Map<number, string>();
let lastT = records[0]?.t ?? 0;
for (const r of records) {
  // 記録の間の時間も 1 秒刻みで進める（timeout 確定のため）
  for (let t = lastT + 1000; t < r.t; t += 1000) finalizer.tick(t);
  lastT = r.t;
  if (!isBlockChild(r.path)) continue;
  const batchNames = namesAt.get(r.t) ?? [];
  if (batchNames.includes(r.text)) continue; // 名前の行（本文ではない）
  // 新しく現れた / 先頭が変わった（使い回された）要素の話者を、同じバッチの名前から決める
  const prev = lastTextOf.get(r.id);
  const isNew = prev === undefined || !(r.text.startsWith(prev.slice(0, 5)) || prev.startsWith(r.text.slice(0, 5)));
  if (isNew) {
    if (batchNames.length) speakerOf.set(r.id, batchNames[batchNames.length - 1]);
    else if (!speakerOf.has(r.id)) speakerOf.set(r.id, "?");
  }
  lastTextOf.set(r.id, r.text);
  finalizer.update(String(r.id), speakerOf.get(r.id) ?? "?", r.text, r.t);
  finalizer.tick(r.t);
}
finalizer.flush(lastT + 60_000);

const t0 = records[0]?.t ?? 0;
const utterances = order
  .map((k) => byKey.get(k)!)
  .filter((u) => u.text)
  .sort((a, b) => a.start - b.start);

fs.writeFileSync(path.join(dir, "transcript.jsonl"), utterances.map((u) => JSON.stringify(u)).join("\n") + "\n");
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round((ms - t0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const md = [
  `# 発話ログ（${path.basename(dir)}）`,
  "",
  `確定待ち ${finalizeAfterMs} ms。時刻は記録開始からの経過。`,
  "",
  ...utterances.map((u) => `- [${mmss(u.start)}] **${u.speaker}**: ${u.text}`),
  "",
].join("\n");
fs.writeFileSync(path.join(dir, "transcript.md"), md);

const reasons = utterances.reduce<Record<string, number>>((acc, u) => ((acc[u.reason] = (acc[u.reason] ?? 0) + 1), acc), {});
const speakers = utterances.reduce<Record<string, number>>((acc, u) => ((acc[u.speaker] = (acc[u.speaker] ?? 0) + 1), acc), {});
const delays = utterances.map((u) => u.end - u.start);
console.log(`発話 ${utterances.length} 件 → ${path.join(dir, "transcript.md")}`);
console.log(`確定の理由: ${JSON.stringify(reasons)}`);
console.log(`話者: ${JSON.stringify(speakers)}`);
console.log(`確定処理の統計: ${JSON.stringify(finalizer.stats)}`);
console.log(`区間の表示時間(start→end, ms): ${percentiles(delays)}`);

function percentiles(xs: number[]) {
  if (xs.length === 0) return "データなし";
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `p50=${q(0.5)} p90=${q(0.9)} max=${s[s.length - 1]}`;
}
