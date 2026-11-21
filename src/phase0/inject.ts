/**
 * ページに注入する DOM 変化レコーダー。
 *
 * Meet の字幕 DOM の構造は非公開なので、ここでは特定のセレクタを決め打ちしない。
 * ページ内の「テキストが変わった要素」をすべて記録し、
 * どの要素が字幕なのか・どう書き換わるのかを後から analyze.ts で調べる。
 *
 * 記録する1件 = { t: 時刻(ms), id: 要素ごとの連番, path: 祖先の要約, text: 変化後のテキスト }
 * 同じ要素は同じ id になるので、字幕1ブロックの書き換わり履歴を追える。
 */
export interface MutationRecordLite {
  t: number;
  id: number;
  path: string;
  text: string;
}

export interface RecorderOptions {
  /** true なら日本語（かな・漢字）を含むテキストだけ記録する */
  japaneseOnly: boolean;
  /** 1件あたりのテキスト最大長 */
  maxTextLength: number;
}

/** addInitScript に渡す関数。ブラウザ内で実行されるので外部の変数は参照できない。 */
export function installRecorder(opts: RecorderOptions): void {
  const w = window as unknown as {
    __mpInstalled?: boolean;
    mpLog?: (batch: unknown[]) => void;
  };
  if (w.__mpInstalled) return;
  w.__mpInstalled = true;

  const JA = /[぀-ヿ㐀-鿿]/;
  const ids = new WeakMap<Element, number>();
  const lastText = new WeakMap<Element, string>();
  let nextId = 1;
  let dirty = new Set<Element>();
  let scheduled = false;

  const idOf = (el: Element): number => {
    let id = ids.get(el);
    if (id === undefined) {
      id = nextId++;
      ids.set(el, id);
    }
    return id;
  };

  const describe = (el: Element): string => {
    const parts: string[] = [];
    let e: Element | null = el;
    for (let i = 0; e && i < 8; i++, e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      const role = e.getAttribute("role");
      const label = e.getAttribute("aria-label");
      const jsname = e.getAttribute("jsname");
      if (role) s += `[role=${role}]`;
      if (label) s += `[aria-label=${label.slice(0, 40)}]`;
      if (jsname) s += `[jsname=${jsname}]`;
      parts.push(s);
    }
    return parts.reverse().join(" > ");
  };

  const flush = () => {
    scheduled = false;
    const batch: unknown[] = [];
    const now = Date.now();
    for (const el of dirty) {
      if (!el.isConnected) continue;
      const raw = (el as HTMLElement).innerText ?? el.textContent ?? "";
      const text = raw.trim().slice(0, opts.maxTextLength);
      if (!text) continue;
      if (opts.japaneseOnly && !JA.test(text)) continue;
      if (lastText.get(el) === text) continue;
      lastText.set(el, text);
      batch.push({ t: now, id: idOf(el), path: describe(el), text });
    }
    dirty = new Set();
    if (batch.length && w.mpLog) w.mpLog(batch);
  };

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      const el = m.type === "characterData" ? m.target.parentElement : (m.target as Element);
      if (!el || el === document.body || el === document.documentElement) continue;
      dirty.add(el);
    }
    if (!scheduled) {
      scheduled = true;
      setTimeout(flush, 100); // 100ms ごとにまとめて送る
    }
  });

  const start = () =>
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}
