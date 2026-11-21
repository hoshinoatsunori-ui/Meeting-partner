/**
 * observe.ts / analyze.ts の動作確認（Meet ではなく test/fake-meet.html を使う）。
 *   MP_CHROME_PATH=<chromium> npm run test:fake
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const url = "file://" + path.resolve("test/fake-meet.html");
const out = execFileSync("npx", ["tsx", "src/phase0/observe.ts", url, "--minutes", "0.05"], {
  encoding: "utf8",
  env: { ...process.env, MP_HEADLESS: "1" },
  input: "",
});
const dir = out.match(/記録: (.+)/)?.[1]?.trim();
assert.ok(dir, "出力先が表示されること");

const recs = fs.readFileSync(path.join(dir, "mutations.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const caption = recs.filter((r) => r.path.includes("字幕テスト"));
const texts = caption.map((r) => r.text);
assert.ok(texts.includes("今日の会議の議題を確認します。"), "最終の字幕テキストが記録されること");
assert.ok(!recs.some((r) => /^\d+$/.test(r.text)), "日本語を含まないテキストは既定で記録しないこと");

const ids = new Set(caption.map((r) => r.id));
assert.ok(ids.size >= 1, "字幕要素に id が振られること");

const analysis = execFileSync("npx", ["tsx", "src/phase0/analyze.ts", dir, "--path", "字幕テスト"], { encoding: "utf8" });
assert.match(analysis, /書き換え [1-9]/, "途中の書き換えを検出すること");
assert.match(analysis, /追記 [1-9]/, "追記を検出すること");
console.log(analysis);
fs.rmSync(dir, { recursive: true });
console.log("OK");
