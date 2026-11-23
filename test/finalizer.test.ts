/**
 * src/core/captions/finalizer.ts の単体テスト（合成データ。ブラウザ不要）
 *   npm run test:unit
 */
import assert from "node:assert/strict";
import { CaptionFinalizer, type Utterance } from "../src/core/captions/finalizer.js";

function setup() {
  const out: Utterance[] = [];
  const f = new CaptionFinalizer((u) => out.push(u));
  const texts = () => out.map((u) => `${u.reason}:${u.text}`);
  return { f, out, texts };
}

const cases: [string, () => void][] = [
  [
    "次の区間が始まったら前の区間を確定し、最後の区間は 7 秒後に確定する",
    () => {
      const { f, texts } = setup();
      f.update("a", "山田", "今日は", 0);
      f.update("a", "山田", "今日は会議です。", 300);
      f.tick(3_000);
      assert.deepEqual(texts(), [], "7 秒経つまで最後の区間は確定しない");
      f.update("a", "山田", "今日は会議です。 次", 3_300);
      assert.deepEqual(texts(), ["next-segment:今日は会議です。"]);
      f.tick(10_299);
      assert.deepEqual(texts(), ["next-segment:今日は会議です。"]);
      f.tick(10_300);
      assert.deepEqual(texts(), ["next-segment:今日は会議です。", "timeout:次"]);
    },
  ],
  [
    "句読点だけ（空白なし）では区切らない",
    () => {
      const { f, texts } = setup();
      f.update("a", "山田", "いやいや。こんな", 0);
      f.update("a", "山田", "いやいや、こんなんで。", 300);
      f.tick(8_000);
      assert.deepEqual(texts(), ["timeout:いやいや、こんなんで。"]);
    },
  ],
  [
    "最後の区間の書き換え・丸ごと削除は確定前なら反映される",
    () => {
      const { f, texts } = setup();
      f.update("a", "山田", "何を作ってるんですか？ それはささ。", 0);
      f.update("a", "山田", "何を作ってるんですか？ 分厚い！", 1_700);
      f.update("a", "山田", "何を作ってるんですか？ 分厚い！ 黒。", 2_000);
      f.update("a", "山田", "何を作ってるんですか？ 分厚い！", 7_400); // 最後の区間が空白ごと消える
      f.tick(20_000);
      assert.deepEqual(texts(), ["next-segment:何を作ってるんですか？", "next-segment:分厚い！"]);
      assert.equal(f.stats.recycled, 0, "空白ごと消えても使い回しと誤判定しない");
    },
  ],
  [
    "timeout で確定した後の書き換え・削除は revision で出し直す",
    () => {
      const { f, out } = setup();
      f.update("a", "山田", "明日。", 0);
      f.tick(7_000);
      f.update("a", "山田", "明日？", 8_000);
      f.tick(15_000);
      f.update("a", "山田", "明日？ 豆", 16_000);
      f.tick(23_000);
      f.update("a", "山田", "明日？", 24_000); // timeout で確定した「豆」が消えた
      assert.deepEqual(
        out.map((u) => [u.reason, u.offset, u.text]),
        [
          ["timeout", 0, "明日。"],
          ["revision", 0, "明日？"],
          ["timeout", 4, "豆"],
          ["revision", 4, ""],
        ],
      );
      assert.equal(f.stats.lateEdits, 2);
    },
  ],
  [
    "確定後に同じブロックへ続きが追記される",
    () => {
      const { f, out } = setup();
      f.update("a", "山田", "こんにちは。", 0);
      f.tick(7_000);
      f.update("a", "山田", "こんにちは。 はい。 何", 40_000);
      f.tick(47_000);
      assert.deepEqual(
        out.map((u) => [u.reason, u.offset, u.text]),
        [
          ["timeout", 0, "こんにちは。"],
          ["next-segment", 7, "はい。"],
          ["timeout", 11, "何"],
        ],
      );
    },
  ],
  [
    "確定済みの部分の先頭が変わったら要素の使い回し（別の発言）として扱う",
    () => {
      const { f, out } = setup();
      f.update("a", "山田", "今。", 0);
      f.update("a", "山田", "スターダムを見てます。", 1_000); // 確定前の書き直し（実データにある音声認識の訂正）
      f.tick(10_000);
      f.update("a", "山田", "全然別の発言です。", 900_000); // 確定後、十数分後に使い回された
      f.tick(910_000);
      assert.deepEqual(
        out.map((u) => [u.blockId, u.reason, u.text]),
        [
          ["a", "timeout", "スターダムを見てます。"],
          ["a#2", "timeout", "全然別の発言です。"],
        ],
      );
      assert.equal(f.stats.recycled, 1);
    },
  ],
  [
    "話者名が変わったら別の発言として扱う",
    () => {
      const { f, out } = setup();
      f.update("a", "山田", "はい。", 0);
      f.tick(7_000);
      f.update("a", "test", "はい。 いいえ。", 8_000);
      f.tick(16_000);
      assert.deepEqual(
        out.map((u) => [u.speaker, u.text]),
        [
          ["山田", "はい。"],
          ["test", "はい。"],
          ["test", "いいえ。"],
        ],
      );
    },
  ],
  [
    "近い時刻に別ブロックへ出た同じ文は 1 つにまとめる",
    () => {
      const { f, texts } = setup();
      f.update("a", "山田", "どっちが喋っているでしょうか？", 0);
      f.update("b", "山田", "どっちが喋っているでしょうか？", 400);
      f.tick(8_000);
      assert.deepEqual(texts(), ["timeout:どっちが喋っているでしょうか？"]);
      assert.equal(f.stats.duplicates, 1);
    },
  ],
  [
    "flush で未確定の区間をすべて確定し、pending で暫定表示を取れる",
    () => {
      const { f, texts } = setup();
      f.update("a", "山田", "終わりです。 最後", 0);
      assert.deepEqual(f.pending(), [{ blockId: "a", speaker: "山田", text: "最後" }]);
      f.flush(1_000);
      assert.deepEqual(texts(), ["next-segment:終わりです。", "flush:最後"]);
      assert.deepEqual(f.pending(), []);
    },
  ],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n${e}`);
  }
}
if (failed) {
  console.log(`\n${failed} 件失敗`);
  process.exit(1);
}
console.log("\nOK");
