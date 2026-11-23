/**
 * Phase 0 / 検証項目 1・2・3・8: Meet に参加し、字幕の書き換わりを記録する。
 *
 *   npm run observe -- <MeetのURL> [--minutes 60] [--all] [--auto] [--snap-every 60]
 *
 *   --minutes N  N 分で自動終了（既定: ブラウザを閉じるか Ctrl+C まで）
 *   --all        日本語を含まないテキストも記録する（既定は日本語のみ）
 *   --auto       マイク・カメラ OFF → 参加ボタン → 字幕 ON を自動で行う（結果は events.jsonl に記録）
 *   --snap-every S  S 秒ごとに HTML とスクリーンショットを自動保存する
 *                   （Enter を押せない環境（別プロセスから起動した時など）向け）
 *
 * 会議の終了（「この会議は終了しました」・退出・削除・ホーム画面への移動）を検知すると自動で終了する。
 *
 * 実行中にターミナルで Enter を押すと、その時点の HTML とスクリーンショットを保存する
 * （字幕が表示されている時に押すと、字幕部分の DOM 構造を後から調べられる）。
 *
 * 出力: logs/<日時>/
 *   mutations.jsonl  テキストが変わった要素の記録（analyze.ts で解析）
 *   events.jsonl     自動操作の成否、メモリ・CPU の計測値
 *   snapshot-*.html / snapshot-*.png  Enter で保存したもの
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import type { Page } from "playwright";
import { launchBot, DEFAULT_PROFILE_DIR } from "./browser.js";
import { installRecorder, type RecorderOptions } from "./inject.js";

// ---- 引数 ----
const args = process.argv.slice(2);
// オプションの値（--minutes 30 の 30 など）を URL と取り違えないよう、http/file で始まるものを URL とする
const url = args.find((a) => /^(https?|file):/.test(a));
const flag = (name: string) => args.includes(name);
const minutesIdx = args.indexOf("--minutes");
const minutes = minutesIdx >= 0 ? Number(args[minutesIdx + 1]) : 0;
const snapIdx = args.indexOf("--snap-every");
const snapEverySec = snapIdx >= 0 ? Number(args[snapIdx + 1]) : 0;
if (!url) {
  console.error("使い方: npm run observe -- <MeetのURL> [--minutes 60] [--all] [--auto] [--snap-every 60]");
  process.exit(1);
}
/** 会議の URL のパス（/xxx-xxxx-xxx）。ここから外れたら会議を離れたとみなす */
const meetingPath = new URL(url).pathname;

// ---- 出力先 ----
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.resolve("logs", stamp);
fs.mkdirSync(outDir, { recursive: true });
const mutationsOut = fs.createWriteStream(path.join(outDir, "mutations.jsonl"));
const eventsOut = fs.createWriteStream(path.join(outDir, "events.jsonl"));
const event = (type: string, data: Record<string, unknown> = {}) => {
  const line = { t: Date.now(), type, ...data };
  eventsOut.write(JSON.stringify(line) + "\n");
  console.log(`[${type}]`, JSON.stringify(data));
};

// ---- 起動 ----
const ctx = await launchBot();
const page = ctx.pages()[0] ?? (await ctx.newPage());

let mutationCount = 0;
await ctx.exposeBinding("mpLog", (_source, batch: unknown[]) => {
  for (const rec of batch) mutationsOut.write(JSON.stringify(rec) + "\n");
  mutationCount += batch.length;
});
const recorderOpts: RecorderOptions = { japaneseOnly: !flag("--all"), maxTextLength: 1000 };
// tsx(esbuild) が関数に付ける __name ヘルパーをブラウザ側で無害化してから注入する
await ctx.addInitScript({
  content: `var __name = (f) => f;\n(${installRecorder.toString()})(${JSON.stringify(recorderOpts)});`,
});

event("start", { url, outDir, profile: DEFAULT_PROFILE_DIR, recorderOpts });
await page.goto(url);

// ---- 自動操作の試行（検証項目 1・2）----
if (flag("--auto")) {
  await tryAutoJoin(page);
  await tryCaptionsOn(page);
  // 入室前に OFF にできなかった場合に備えて、入室後にも確認する
  await muteSelf(page, "in-call");
} else {
  console.log("\nブラウザで手動で参加し、字幕を ON・日本語にしてください。");
}
console.log("字幕が出ている時に Enter を押すと HTML とスクリーンショットを保存します。\n");

// ---- スナップショット（Enter）----
let snapNo = 0;
const rl = readline.createInterface({ input: process.stdin });
const snapshot = async (trigger: string) => {
  snapNo++;
  const base = path.join(outDir, `snapshot-${snapNo}`);
  try {
    fs.writeFileSync(`${base}.html`, await page.content());
    await page.screenshot({ path: `${base}.png` });
    event("snapshot", { file: `${base}.html`, trigger });
  } catch (e) {
    event("snapshot-failed", { error: String(e), trigger });
  }
};
rl.on("line", () => void snapshot("enter"));
const snapTimer = snapEverySec > 0 ? setInterval(() => void snapshot("timer"), snapEverySec * 1000) : undefined;

// ---- リソース計測（検証項目 8）: 60 秒ごと ----
const cdp = await ctx.newCDPSession(page);
await cdp.send("Performance.enable");
const metricsTimer = setInterval(async () => {
  try {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    event("metrics", {
      jsHeapUsedMB: round(m.JSHeapUsedSize / 1e6),
      domNodes: m.Nodes,
      ...browserMemory(),
      mutationsSoFar: mutationCount,
    });
  } catch (e) {
    event("metrics-failed", { error: String(e) });
  }
}, 60_000);

// ---- 終了処理 ----
let closing = false;
const finish = async (reason: string) => {
  if (closing) return;
  closing = true;
  clearInterval(metricsTimer);
  clearInterval(snapTimer);
  clearInterval(endTimer);
  rl.close();
  event("end", { reason, mutations: mutationCount });
  await ctx.close().catch(() => {});
  await new Promise<void>((r) => mutationsOut.end(r));
  await new Promise<void>((r) => eventsOut.end(r));
  console.log(`\n記録: ${outDir}\n解析: npm run analyze -- ${outDir}`);
  process.exit(0);
};
ctx.on("close", () => void finish("browser-closed"));
// 会議の終了を 3 秒ごとに確認する
const endTimer = setInterval(async () => {
  const reason = await detectMeetingEnd(page).catch(() => null);
  if (!reason) return;
  event("meeting-ended", { detail: reason });
  void finish("meeting-ended");
}, 3_000);
process.on("SIGINT", () => void finish("ctrl-c"));
if (minutes > 0) setTimeout(() => void finish(`timeout-${minutes}min`), minutes * 60_000);

// ---- 補助関数 ----
function round(n: number) {
  return Math.round(n * 10) / 10;
}

/**
 * プロファイルを使っている Chrome プロセス群のメモリ合計（MB）。
 * - Windows: browserRssMB = プライベートバイト（PrivatePageCount）の合計。
 *   WorkingSet は chrome.dll 等の共有ページを各プロセスが重複して含む（1 プロセス約 300MB）ため、
 *   合計すると実使用量の 10 倍近くになり、増加傾向も見えにくい。参考値として browserWorkingSetSumMB に残す。
 * - Linux / macOS: ps の RSS 合計（共有ページの重複を多少含む）。
 */
function browserMemory(): { browserRssMB: number | null; browserWorkingSetSumMB?: number; chromeProcs?: number } {
  const profile = DEFAULT_PROFILE_DIR.toLowerCase();
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object CommandLine,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", windowsHide: true },
      );
      type Proc = { CommandLine: string | null; WorkingSetSize: number; PrivatePageCount: number };
      const parsed = JSON.parse(out.trim() || "[]") as Proc | Proc[];
      const procs = (Array.isArray(parsed) ? parsed : [parsed]).filter((p) =>
        (p.CommandLine ?? "").toLowerCase().includes(profile),
      );
      let priv = 0;
      let ws = 0;
      for (const p of procs) {
        priv += Number(p.PrivatePageCount) || 0;
        ws += Number(p.WorkingSetSize) || 0;
      }
      return {
        browserRssMB: round(priv / 1024 / 1024),
        browserWorkingSetSumMB: round(ws / 1024 / 1024),
        chromeProcs: procs.length,
      };
    }
    // Linux / macOS: ps の RSS（KB）
    const out = execFileSync("ps", ["-axo", "rss=,command="], { encoding: "utf8" });
    let kb = 0;
    let n = 0;
    for (const line of out.split("\n")) {
      if (!line.toLowerCase().includes(profile)) continue;
      kb += Number(line.trim().split(/\s+/)[0]) || 0;
      n++;
    }
    return { browserRssMB: round(kb / 1024), chromeProcs: n };
  } catch {
    return { browserRssMB: null };
  }
}

/**
 * 参加ボタンを押す。ボタンの表記は UI 言語・状況で変わるため候補をまとめて待つ。
 * 実機（2026-11, 日本語 UI）: 招待済み・アクセス「オープン」等では「今すぐ参加」、
 * アクセス「制限付き」では「参加をリクエスト」（主催者の承認待ちになる）。
 * 押す前にマイク・カメラを OFF にする（ボットの PC の音・映像を会議に流さないため）。
 */
async function tryAutoJoin(p: Page) {
  const joinBtn = p.getByRole("button", { name: /今すぐ参加|参加をリクエスト|Join now|Ask to join/i }).first();
  try {
    await joinBtn.waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    event("auto-join", { ok: false, note: "参加ボタンが見つからない。手動で参加してください" });
    await p.screenshot({ path: path.join(outDir, "auto-join-failed.png") }).catch(() => {});
    return;
  }
  await muteSelf(p, "pre-join");
  const matched = (await joinBtn.innerText().catch(() => "")).trim();
  await joinBtn.click();
  event("auto-join", { ok: true, matched });
}

/**
 * マイクとカメラを OFF にする。
 * 実機（2026-11-23, 日本語 UI）のボタン: <button aria-label="マイクをオフ" data-is-muted="false">
 * （カメラは aria-label="カメラをオフ"）。表示されるツールチップ「マイクをオフにする（Ctrl+D キー）」とは
 * 名前が違うので、名前ではなく data-is-muted 属性で状態を見る。
 * トグルのショートカット（Ctrl+D / Ctrl+E）は状態が分からないと逆効果になるので使わない。
 */
async function muteSelf(p: Page, phase: "pre-join" | "in-call") {
  const targets = [
    // 「マイクをオフ」「マイクをオンにする」等。他の参加者の「〜さんのマイクを…」に当たらないよう先頭一致にする
    { kind: "mic", label: /^マイクをオ|^Turn (on|off) microphone/i },
    { kind: "camera", label: /^カメラをオ|^Turn (on|off) camera/i },
  ];
  const result: Record<string, string> = {};
  for (const t of targets) {
    const btn = p.locator("button[data-is-muted]").and(p.getByRole("button", { name: t.label }));
    try {
      const target = btn.first();
      await target.waitFor({ state: "visible", timeout: 10_000 });
      if ((await target.getAttribute("data-is-muted")) === "true") {
        result[t.kind] = "already-off";
        continue;
      }
      await target.click();
      await p.waitForFunction(
        (el) => el?.getAttribute("data-is-muted") === "true",
        await target.elementHandle(),
        { timeout: 3_000 },
      );
      result[t.kind] = "turned-off";
    } catch (e) {
      result[t.kind] = /Timeout.*waitFor|waiting for locator/i.test(String(e))
        ? "button-not-found"
        : `failed: ${String(e).slice(0, 80)}`;
    }
  }
  const ok = Object.values(result).every((v) => v === "turned-off" || v === "already-off");
  event("auto-mute", { phase, ok, ...result });
}

/**
 * 会議が終わったかを調べる。終わっていれば理由（文字列）、続いていれば null。
 * - 画面の表示: 2026-11 実機で「この会議は終了しました」「主催者が会議を終了して全員を退出させました」
 *   → 60 秒のカウントダウン（「ホーム画面に戻ります」）→ Meet のホーム画面へ移動を確認。
 *   自分で退出した時・削除された時の表記は未確認の想定。
 * - URL: 会議コードを含まない URL（ホーム画面など）に移った
 */
async function detectMeetingEnd(p: Page): Promise<string | null> {
  if (p.isClosed()) return null; // ブラウザ終了は ctx の close で扱う
  const current = new URL(p.url());
  if (!current.pathname.startsWith(meetingPath)) return `url-changed: ${current.origin}${current.pathname}`;
  const ended = p
    .getByText(
      // 実機で確認: 「この会議は終了しました」（時間制限）、「主催者が会議を終了して全員を退出させました」、
      // どちらの終了画面にも出る「ホーム画面に戻ります」（カウントダウン）。その他は未確認の想定。
      /この会議は終了しました|全員を退出させました|ホーム画面に戻ります|通話から退出しました|会議から退出しました|ミーティングから退出しました|会議から削除されました|The meeting has ended|You left the meeting|You've left the call|You've been removed|Returning to home screen/i,
    )
    .first();
  if (await ended.isVisible()) return `text: ${(await ended.innerText()).split("\n")[0].slice(0, 40)}`;
  return null;
}

/**
 * 字幕を ON にする。
 * 1) 字幕ボタン（表記は未検証の想定）を探す
 * 2) 見つからなければ Google 公式ヘルプ記載のショートカット "c"（字幕の表示/非表示）を押す
 * 字幕の言語設定は UI が未確認なので自動化せず、手動確認とする。
 */
async function tryCaptionsOn(p: Page) {
  // 入室完了を待つ（参加承認待ちの時間を見込んで長め）
  await p.waitForTimeout(5_000);
  // 2026-11 実機（Windows / 日本語 UI）: 入室時の字幕は OFF。
  // 操作バーの「字幕と翻訳」(translate_cc) を開くと、その中に「字幕をオンにする」がある。
  // UI によっては操作バーに直接「字幕をオンにする」が出る可能性もあるので両方を試す。
  const onBtn = p.getByRole("button", { name: /字幕をオン|Turn on captions/i }).first();
  const menuBtn = p.getByRole("button", { name: /^字幕と翻訳$|Captions and translation/i }).first();
  const deadline = Date.now() + 120_000; // 参加承認待ちを見込んで長め
  while (Date.now() < deadline) {
    try {
      if (await onBtn.isVisible()) {
        await onBtn.click();
        event("auto-captions", { ok: true, method: "button" });
        return;
      }
      if (await menuBtn.isVisible()) {
        await menuBtn.click();
        await onBtn.waitFor({ state: "visible", timeout: 5_000 });
        await onBtn.click();
        event("auto-captions", { ok: true, method: "menu" });
        await p.keyboard.press("Escape").catch(() => {});
        return;
      }
    } catch {
      // 表示が変わった直後などは次の周回で再試行
    }
    await p.waitForTimeout(1_000);
  }
  await p.keyboard.press("c");
  event("auto-captions", {
    ok: "unknown",
    method: "shortcut-c",
    note: "画面で字幕が出たか目視確認してください（もう一度押すと OFF になる）",
  });
}
