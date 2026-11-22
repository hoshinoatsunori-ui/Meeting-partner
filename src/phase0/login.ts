/**
 * Phase 0 / 準備: ボット専用 Google アカウントで手動ログインし、プロファイルに保存する。
 *   npm run login
 * ブラウザが開いたらログインし、終わったらブラウザを閉じる。
 *
 * Playwright 経由で起動した Chrome（自動操作モード）では、Google のログイン画面が
 * 「このブラウザまたはアプリは安全でない可能性があります」と拒否する（Windows 実機で確認）。
 * そのためログインだけは Playwright を使わず、インストール済みの Chrome を
 * 同じプロファイル（--user-data-dir）で普通に起動する。保存された Cookie は observe でそのまま使われる。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PROFILE_DIR } from "./browser.js";

const chrome = findChrome();
if (!chrome) {
  console.error("Google Chrome が見つかりません。環境変数 MP_CHROME_PATH に chrome の実行ファイルを指定してください。");
  process.exit(1);
}

fs.mkdirSync(DEFAULT_PROFILE_DIR, { recursive: true });
console.log(`Chrome    : ${chrome}`);
console.log(`プロファイル: ${DEFAULT_PROFILE_DIR}`);
console.log("ボット専用アカウントでログインしてください。終わったらブラウザ（このウィンドウ）を閉じると終了します。");
console.log("※ 同じプロファイルの Chrome が既に開いていると、ウィンドウが開かずにすぐ終了することがあります。");

const child = spawn(
  chrome,
  [
    `--user-data-dir=${DEFAULT_PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "https://accounts.google.com/",
  ],
  { stdio: "ignore" },
);
child.on("error", (e) => {
  console.error("Chrome を起動できませんでした:", e);
  process.exit(1);
});
child.on("exit", () => console.log("保存しました。"));

/** インストール済み Chrome の実行ファイルを探す */
function findChrome(): string | undefined {
  if (process.env.MP_CHROME_PATH) return process.env.MP_CHROME_PATH;
  const candidates: string[] = [];
  if (process.platform === "win32") {
    for (const base of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    candidates.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome");
  }
  return candidates.find((c) => fs.existsSync(c));
}
