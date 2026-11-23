import { chromium, type BrowserContext } from "playwright";
import path from "node:path";

/** ボット専用アカウントのログイン状態を保存するプロファイルの場所 */
export const DEFAULT_PROFILE_DIR = path.resolve(".profile/bot");

/**
 * ログイン済みプロファイルで Chrome を開く。
 * - 既定ではインストール済みの Google Chrome（channel: "chrome"）を使う。
 *   Google のログイン画面は自動化用 Chromium を拒否することがあるため。
 * - 環境変数 MP_CHROME_PATH があればその実行ファイルを使う（テスト用など）。
 * - headless は使わない（Meet が headless を弾くという報告があるため）。
 *   ディスプレイの無い Linux では Xvfb 上で実行する（README 参照）。
 */
export async function launchBot(profileDir = DEFAULT_PROFILE_DIR): Promise<BrowserContext> {
  const executablePath = process.env.MP_CHROME_PATH;
  return chromium.launchPersistentContext(profileDir, {
    headless: process.env.MP_HEADLESS === "1", // テスト専用。Meet では使わない
    ...(executablePath ? { executablePath } : { channel: "chrome" }),
    viewport: null,
    locale: "ja-JP",
    // Playwright は既定で --no-sandbox を付けて起動する（Chrome に「サポートされていないコマンドライン フラグ」
    // の警告が出る）。サンドボックスを無効にしたまま Web ページを開かないよう、有効にする。
    chromiumSandbox: true,
  });
}
