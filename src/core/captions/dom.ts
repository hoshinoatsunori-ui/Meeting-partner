/**
 * Meet の字幕 DOM の読み取り。Meet の DOM に依存する部分はこのファイルに集約する（PLAN.md §4.2）。
 *
 * 実機（2026-11-22〜23, 日本語 UI）で確認した構造。クラス名は難読化されているので使わない:
 *   div[role=region][aria-label=字幕]
 *     div            ← 話者ブロック（参加者・端末が替わるたびに増える。最大 22 個ほどで古いものから消える）
 *       div          ← 1 つ目の子: アイコン img ＋ 表示名（span）
 *       div          ← 最後の子: 本文（話し続ける間は伸び続ける）
 *     div / div      ← 字幕以外（「最新の字幕に移動」ボタンなど。img を含まないので除外する）
 */

export interface CaptionBlock {
  /** ブロック要素ごとの識別子（要素が使い回されても同じ値なので、先頭の変化は finalizer 側で判定する） */
  key: string;
  speaker: string;
  text: string;
}

/** 字幕 region のセレクタ（日本語 UI / 英語 UI） */
export const CAPTION_REGION_SELECTOR = '[role="region"][aria-label="字幕"], [role="region"][aria-label="Captions"]';

/**
 * ブラウザ内で実行する: 字幕 region の話者ブロックを上から順に読む。region が無ければ null。
 * page.evaluate(readCaptionBlocks, CAPTION_REGION_SELECTOR) のように使う（外側の変数は参照できない）。
 */
export function readCaptionBlocks(regionSelector: string): CaptionBlock[] | null {
  const region = document.querySelector(regionSelector);
  if (!region) return null;
  const w = window as unknown as { __mpBlockIds?: WeakMap<Element, number>; __mpNextBlockId?: number };
  w.__mpBlockIds ??= new WeakMap();
  w.__mpNextBlockId ??= 1;

  const out: CaptionBlock[] = [];
  for (const block of Array.from(region.children)) {
    if (!block.querySelector("img")) continue; // 話者ブロックはアイコンを含む
    const kids = Array.from(block.children).filter((e) => e.tagName === "DIV") as HTMLElement[];
    if (kids.length < 2) continue;
    const speaker = (kids[0].innerText ?? kids[0].textContent ?? "").trim();
    const text = (kids[kids.length - 1].innerText ?? kids[kids.length - 1].textContent ?? "").trim();
    let id = w.__mpBlockIds.get(block);
    if (id === undefined) {
      id = w.__mpNextBlockId++;
      w.__mpBlockIds.set(block, id);
    }
    out.push({ key: `b${id}`, speaker, text });
  }
  return out;
}
