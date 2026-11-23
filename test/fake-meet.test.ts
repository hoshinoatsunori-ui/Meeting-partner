/**
 * observe.ts / analyze.ts の動作確認（Meet ではなく test/fake-meet.html を使う）。
 *   MP_CHROME_PATH=<chromium> npm run test:fake
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const url = pathToFileURL(path.resolve("test/fake-meet.html")).href;
// Windows では npx が npx.cmd なので execFileSync("npx") は ENOENT になる。
// 実行中の node に tsx ローダーを読み込ませて起動する（全 OS 共通）。
const tsx = (script: string, args: string[]) => [process.execPath, ["--import", "tsx", script, ...args]] as const;
const out = execFileSync(...tsx("src/phase0/observe.ts", [url, "--minutes", "0.05"]), {
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

const analysis = execFileSync(...tsx("src/phase0/analyze.ts", [dir, "--path", "字幕テスト"]), { encoding: "utf8" });
assert.match(analysis, /書き換え [1-9]/, "途中の書き換えを検出すること");
assert.match(analysis, /追記 [1-9]/, "追記を検出すること");
console.log(analysis);
fs.rmSync(dir, { recursive: true });

// ---- --auto（マイク/カメラ OFF → 参加 → 字幕 ON）と会議終了の検知 ----
const started = Date.now();
const out2 = execFileSync(...tsx("src/phase0/observe.ts", [`${url}?auto=1&end=4`, "--auto", "--minutes", "1"]), {
  encoding: "utf8",
  env: { ...process.env, MP_HEADLESS: "1" },
  input: "",
});
const dir2 = out2.match(/記録: (.+)/)?.[1]?.trim();
assert.ok(dir2, "出力先が表示されること（--auto）");
const events = fs
  .readFileSync(path.join(dir2, "events.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const ev = (type: string) => events.filter((e) => e.type === type);

const preJoin = ev("auto-mute").find((e) => e.phase === "pre-join");
assert.equal(preJoin?.ok, true, "入室前にマイク・カメラを OFF にできること");
assert.equal(preJoin?.mic, "turned-off");
assert.equal(preJoin?.camera, "turned-off");
assert.equal(ev("auto-mute").find((e) => e.phase === "in-call")?.mic, "already-off", "入室後の確認で OFF のままであること");
assert.equal(ev("auto-join")[0]?.ok, true, "参加ボタンを押せること");
assert.equal(ev("auto-captions")[0]?.ok, true, "字幕と翻訳メニューから字幕を ON にできること");
assert.equal(ev("meeting-ended").length, 1, "会議の終了を検知すること");
assert.equal(ev("end")[0]?.reason, "meeting-ended", "会議の終了で自動終了すること");
assert.ok(Date.now() - started < 30_000, "--minutes を待たずに終了すること");
const recs2 = fs.readFileSync(path.join(dir2, "mutations.jsonl"), "utf8");
assert.ok(recs2.includes("今日の会議の議題を確認します。"), "字幕 ON の後に字幕が記録されること");
fs.rmSync(dir2, { recursive: true });

console.log("OK");
