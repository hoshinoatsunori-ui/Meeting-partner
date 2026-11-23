/**
 * Phase 0 / 検証項目 4: 発話ログ（transcript.jsonl）から、要約・決定事項・ToDo・未解決論点を作る。
 * PLAN.md §4.2 の合否基準（字幕ログから作った要約に致命的な誤りがないこと）を判断する材料にする。
 *
 *   npm run summarize -- logs/<日時> [--model claude-opus-5-5] [--effort medium]
 *
 * 先に `npm run transcript -- logs/<日時>` で transcript.jsonl を作っておく。
 * API キーはプロジェクト直下の .env（ANTHROPIC_API_KEY）から読む。
 *
 * 出力: logs/<日時>/summary.json（構造化出力そのまま）、summary.md（読む用）
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { requireEnv } from "../core/env.js";
import type { Utterance } from "../core/captions/finalizer.js";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--"));
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const model = opt("--model", "claude-opus-5-5");
const effort = opt("--effort", "medium") as "low" | "medium" | "high" | "xhigh" | "max";
if (!dir) {
  console.error("使い方: npm run summarize -- logs/<日時> [--model claude-opus-5-5] [--effort medium]");
  process.exit(1);
}
const transcriptFile = path.join(dir, "transcript.jsonl");
if (!fs.existsSync(transcriptFile)) {
  console.error(`${transcriptFile} がありません。先に npm run transcript -- ${dir} を実行してください。`);
  process.exit(1);
}

// ---- 発話ログを読みやすい行に ----
const utterances: Utterance[] = fs
  .readFileSync(transcriptFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
if (utterances.length === 0) {
  console.error("発話が 0 件です。");
  process.exit(1);
}
const t0 = utterances[0].start;
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round((ms - t0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
const transcriptText = utterances.map((u) => `[${mmss(u.start)}] ${u.speaker}: ${u.text}`).join("\n");

// ---- 出力の形（構造化出力の JSON スキーマ）----
interface MeetingSummary {
  summary: string;
  decisions: { text: string; evidence: string }[];
  todos: { task: string; owner: string | null; due: string | null; evidence: string }[];
  open_issues: { text: string; evidence: string }[];
  caption_issues: { heard: string; likely: string | null; note: string }[];
}
const evidence = { type: "string", description: "根拠になった発話の時刻（例: 03:12）。複数ならカンマ区切り" };
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "decisions", "todos", "open_issues", "caption_issues"],
  properties: {
    summary: { type: "string", description: "会議全体の要約（日本語、5〜10 文）" },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "evidence"],
        properties: { text: { type: "string" }, evidence },
      },
    },
    todos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["task", "owner", "due", "evidence"],
        properties: {
          task: { type: "string" },
          owner: { type: ["string", "null"], description: "担当者。発話から分からなければ null" },
          due: { type: ["string", "null"], description: "期限。発話から分からなければ null" },
          evidence,
        },
      },
    },
    open_issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "evidence"],
        properties: { text: { type: "string" }, evidence },
      },
    },
    caption_issues: {
      type: "array",
      description: "自動字幕の誤認識と思われる箇所",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heard", "likely", "note"],
        properties: {
          heard: { type: "string", description: "字幕に出た文字列" },
          likely: { type: ["string", "null"], description: "おそらく正しい語。推測できなければ null" },
          note: { type: "string" },
        },
      },
    },
  },
} as const;

// system は固定（キャッシュが効くよう、時刻などの可変値は入れない。PLAN.md §4.3）
const SYSTEM = `あなたは会議の議事録担当です。Google Meet の自動字幕から作った発話ログを読み、日本語で議事録の材料をまとめます。

発話ログについて:
- 各行は「[経過時間] 話者名: 発言」です。話者名が「?」の行は話者が分からない発言です。
- 自動字幕なので、誤変換・聞き間違い・言い直しを含みます。文脈から正しい意味を推定してまとめてください。
- 推定に自信がない語は、要約の中で断定せず、caption_issues に挙げてください。

まとめ方:
- 発話ログに無いことは書かないでください。決定事項・ToDo は、会話の中で実際に合意・依頼されたものだけにします。該当が無ければ空の配列にします。
- 雑談・テストのための発言が中心の会議なら、要約でそう述べてください。
- evidence には根拠になった発言の経過時間を書いてください。`;

// ---- 呼び出し ----
const apiKey = requireEnv("ANTHROPIC_API_KEY");
const client = new Anthropic({ apiKey });

console.log(`モデル ${model} / effort ${effort} / 発話 ${utterances.length} 件 で要約します…`);
const started = Date.now();
let response;
try {
  response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    // 安全分類器が回答を断った場合に、サーバー側で推奨の代替モデルで再実行する
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: "user", content: `以下の発話ログをまとめてください。\n\n<transcript>\n${transcriptText}\n</transcript>` }],
  });
} catch (e) {
  if (e instanceof Anthropic.AuthenticationError) console.error("API キーが正しくありません（.env の ANTHROPIC_API_KEY を確認してください）。");
  else if (e instanceof Anthropic.RateLimitError) console.error("レート制限にかかりました。少し待ってから再実行してください。");
  else if (e instanceof Anthropic.APIError) console.error(`API エラー ${e.status}: ${e.message}`);
  else console.error(e);
  process.exit(1);
}

if (response.stop_reason === "refusal") {
  console.error(`回答を断られました: ${response.stop_details?.category ?? "-"} ${response.stop_details?.explanation ?? ""}`);
  process.exit(1);
}
if (response.stop_reason === "max_tokens") {
  console.error("出力が max_tokens で途中終了しました。");
  process.exit(1);
}
const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
const result = JSON.parse(text) as MeetingSummary;

// ---- 保存 ----
fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ model: response.model, effort, result }, null, 2));
const list = <T>(xs: T[], f: (x: T) => string) => (xs.length ? xs.map((x) => `- ${f(x)}`).join("\n") : "- （なし）");
const md = `# 会議の要約（${path.basename(dir)}）

モデル: ${response.model} / effort: ${effort} / 発話 ${utterances.length} 件

## 要約
${result.summary}

## 決定事項
${list(result.decisions, (d) => `${d.text}（${d.evidence}）`)}

## ToDo
${list(result.todos, (t) => `${t.task} — 担当: ${t.owner ?? "未定"} / 期限: ${t.due ?? "未定"}（${t.evidence}）`)}

## 未解決論点
${list(result.open_issues, (o) => `${o.text}（${o.evidence}）`)}

## 字幕の誤認識と思われる箇所
${list(result.caption_issues, (c) => `「${c.heard}」→ ${c.likely ? `「${c.likely}」` : "不明"}: ${c.note}`)}
`;
fs.writeFileSync(path.join(dir, "summary.md"), md);

const u = response.usage;
// 料金の目安（Claude Opus 5.5: 入力 $4 / 出力 $20 per 100 万トークン）
const usd = model === "claude-opus-5-5" ? (u.input_tokens * 4 + u.output_tokens * 20) / 1e6 : null;
console.log(md);
console.log(`保存: ${path.join(dir, "summary.md")}`);
console.log(
  `所要 ${((Date.now() - started) / 1000).toFixed(1)} 秒 / 入力 ${u.input_tokens} トークン / 出力 ${u.output_tokens} トークン` +
    (usd !== null ? ` / 約 $${usd.toFixed(3)}` : ""),
);
