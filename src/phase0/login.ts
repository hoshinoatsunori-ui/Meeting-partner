/**
 * Phase 0 / 準備: ボット専用 Google アカウントで手動ログインし、プロファイルに保存する。
 *   npm run login
 * ブラウザが開いたらログインし、終わったらブラウザを閉じる。
 */
import { launchBot, DEFAULT_PROFILE_DIR } from "./browser.js";

const ctx = await launchBot();
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://accounts.google.com/");
console.log(`プロファイル: ${DEFAULT_PROFILE_DIR}`);
console.log("ボット専用アカウントでログインしてください。終わったらブラウザを閉じると終了します。");
await new Promise<void>((resolve) => ctx.on("close", () => resolve()));
console.log("保存しました。");
