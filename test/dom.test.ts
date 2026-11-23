/**
 * src/core/captions/dom.ts の動作確認（実機の構造を写した test/fixtures/captions-dom.html を使う）
 *   npm run test:dom            （MP_CHROME_PATH で Chrome/Chromium を指定可）
 *   npm run test:dom -- <snapshot.html>   observe のスナップショットで確認する（ブロック一覧を表示）
 */
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { readCaptionBlocks, CAPTION_REGION_SELECTOR } from "../src/core/captions/dom.js";

const target = process.argv[2];
const executablePath = process.env.MP_CHROME_PATH;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : { channel: "chrome" }) });
// スナップショットはページのスクリプトを動かさずに DOM だけ見る
const ctx = await browser.newContext({ javaScriptEnabled: !target });
const page = await ctx.newPage();
await page.addInitScript({ content: "var __name = (f) => f;" });

try {
  if (target) {
    await page.goto(pathToFileURL(path.resolve(target)).href);
    const blocks = await page.evaluate(readCaptionBlocks, CAPTION_REGION_SELECTOR);
    if (!blocks) console.log("字幕 region がありません");
    else for (const b of blocks) console.log(`${b.key}\t${b.speaker}\t${b.text.slice(0, 60)}`);
  } else {
    await page.goto(pathToFileURL(path.resolve("test/fixtures/captions-dom.html")).href);
    const first = await page.evaluate(readCaptionBlocks, CAPTION_REGION_SELECTOR);
    assert.deepEqual(first, [
      { key: "b1", speaker: "山田太郎", text: "こんにちは。 今日の議題を確認します。" },
      { key: "b2", speaker: "test", text: "はい、お願いします" },
    ]);

    // 本文が伸びても同じ key のまま読めること
    await page.evaluate(() => {
      const texts = document.querySelectorAll(".ygicle");
      texts[1].textContent = "はい、お願いします。 資料は共有済みです";
    });
    const second = await page.evaluate(readCaptionBlocks, CAPTION_REGION_SELECTOR);
    assert.deepEqual(second?.[1], { key: "b2", speaker: "test", text: "はい、お願いします。 資料は共有済みです" });

    // region が無い時は null
    await page.evaluate(() => document.querySelector('[role="region"]')?.remove());
    assert.equal(await page.evaluate(readCaptionBlocks, CAPTION_REGION_SELECTOR), null);
    console.log("OK");
  }
} finally {
  await browser.close();
}
