/**
 * 字幕の確定処理（PLAN.md §4.2）。ブラウザに依存しない純粋なロジック。
 *
 * 入力: 字幕ブロックの更新 update(blockId, speaker, text, t) と時刻の経過 tick(now)
 * 出力: 確定した発話（Utterance）を emit で渡す
 *
 * Phase 0 の実測（docs/phase0.md）に基づくルール:
 *  1. 本文を「句読点（。？！）＋空白」で区間に分ける。句読点だけでは分けない
 *     （空白の無い「。」の前は書き換わることがある）。
 *  2. 最後の区間より前は、次の区間が始まった時点で確定（実測 880 回の書き換えで一度も変わらなかった）。
 *  3. 最後の区間は finalizeAfterMs（既定 7 秒）更新が無ければ確定
 *     （最後の区間が丸ごと消えることがあり、最大で 5.5 秒後だった）。
 *  4. ブロックの要素は Meet に使い回されるので、本文の先頭が変わったら別の発言とみなす。
 *  5. 同じ部屋の複数端末が同じ声を拾うと同じ文が別ブロックに出るので、近い時刻の同じ文は 1 つにまとめる。
 *
 * 3. で確定した後にその区間が書き換わった（または消えた）場合は、同じ blockId・offset で
 * reason: "revision" の発話を出し直す。受け取る側は同じキーの発話を置き換える（text が空なら削除）。
 */

export interface Utterance {
  /** ブロックの識別子（使い回しを区別するため、作り直しごとに "#2" 等が付く） */
  blockId: string;
  /** ブロック本文の中での開始位置（文字数）。blockId と合わせて発話のキーになる */
  offset: number;
  speaker: string;
  text: string;
  /** その区間が最初に表示された時刻（ms） */
  start: number;
  /** 確定時点でのその区間の最終更新時刻（ms） */
  end: number;
  /** next-segment: 次の区間が始まった / timeout: 一定時間更新が無い / flush: 終了時 / revision: 確定後の書き換え */
  reason: "next-segment" | "timeout" | "flush" | "revision";
}

export interface FinalizerOptions {
  /** 最後の区間をこの時間更新が無ければ確定する（ms） */
  finalizeAfterMs: number;
  /** この時間内に別ブロックで同じ文が出たら重複として捨てる（ms） */
  dedupeWindowMs: number;
}

export const DEFAULT_FINALIZER_OPTIONS: FinalizerOptions = { finalizeAfterMs: 7_000, dedupeWindowMs: 5_000 };

interface BlockState {
  key: string; // 外から渡された blockId
  uid: string; // 作り直しを区別した内部 ID
  speaker: string;
  text: string;
  /** ここまでは確定済み（emit 済み） */
  committedLen: number;
  /** ここまでは「次の区間が始まった」ことで確定した、もう変わらない部分 */
  safeLen: number;
  /** timeout で確定した区間を出し直す必要がある時の開始位置 */
  revisingOffset: number | null;
  pendingSince: number | null;
  lastUpdate: number;
}

/** 「句読点＋空白」の直後の位置の一覧 */
function boundaries(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/[。？！?!.]\s+/g)) out.push(m.index! + m[0].length);
  return out;
}

function commonPrefix(a: string, b: string): number {
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return k;
}

const normalize = (s: string) => s.replace(/[\s。、，,．.？?！!]/g, "");

export class CaptionFinalizer {
  private readonly opts: FinalizerOptions;
  private readonly blocks = new Map<string, BlockState>();
  private readonly generation = new Map<string, number>();
  private recent: Utterance[] = [];

  readonly stats = { updates: 0, emitted: 0, recycled: 0, lateEdits: 0, duplicates: 0 };

  constructor(
    private readonly emit: (u: Utterance) => void,
    opts: Partial<FinalizerOptions> = {},
  ) {
    this.opts = { ...DEFAULT_FINALIZER_OPTIONS, ...opts };
  }

  /** ブロックの本文が変わった（または初めて見えた） */
  update(blockId: string, speaker: string, rawText: string, t: number): void {
    this.stats.updates++;
    const text = rawText.trimEnd();
    let b = this.blocks.get(blockId);

    if (b && b.text === text && b.speaker === speaker) return;

    if (b) {
      // Meet は最後の区間を消す時に前の空白も消す（「A。 B。」→「A。」）ので、末尾の空白は比べない
      const committed = b.text.slice(0, b.committedLen).trimEnd();
      const safe = b.text.slice(0, b.safeLen).trimEnd();
      if (b.speaker !== speaker) {
        b = this.recycle(b, speaker, t);
      } else if (!text.startsWith(committed)) {
        const k = commonPrefix(committed, text);
        if (k > 0 && k >= safe.length) {
          // timeout で確定した最後の区間が後から書き換わった / 消えた
          this.stats.lateEdits++;
          b.revisingOffset = b.safeLen;
          b.committedLen = b.safeLen;
          b.pendingSince ??= t;
        } else {
          // 先頭から別物 = 要素の使い回し（別の発言）
          b = this.recycle(b, speaker, t);
        }
      }
    } else {
      b = this.newBlock(blockId, speaker);
      this.blocks.set(blockId, b);
    }

    b.text = text;
    b.lastUpdate = t;
    if (text.length > b.committedLen && b.pendingSince === null) b.pendingSince = t;

    // 2. 最後の「句読点＋空白」より前は確定
    const bs = boundaries(text);
    const last = bs.length ? bs[bs.length - 1] : 0;
    if (last > b.committedLen) {
      this.commit(b, last, b.revisingOffset !== null ? "revision" : "next-segment");
      b.safeLen = last;
    } else if (last > b.safeLen) {
      b.safeLen = last;
    }

    // timeout で確定済みの区間が丸ごと消えて、出し直すものが無くなった場合
    if (b.revisingOffset !== null && text.length <= b.committedLen) {
      this.emitUtterance(b, b.revisingOffset, "", t, t, "revision");
      b.revisingOffset = null;
      b.pendingSince = null;
    }
  }

  /** 時刻を進める。最後の区間が一定時間更新されていなければ確定する */
  tick(now: number): void {
    for (const b of this.blocks.values()) {
      if (b.text.length <= b.committedLen) continue;
      if (now - b.lastUpdate < this.opts.finalizeAfterMs) continue;
      this.commit(b, b.text.length, b.revisingOffset !== null ? "revision" : "timeout");
    }
    this.recent = this.recent.filter((u) => now - u.end < this.opts.dedupeWindowMs * 4);
  }

  /** 会議終了時などに、未確定の区間をすべて確定する */
  flush(now: number): void {
    for (const b of this.blocks.values()) {
      if (b.text.length > b.committedLen) this.commit(b, b.text.length, b.revisingOffset !== null ? "revision" : "flush");
    }
    this.tick(now);
  }

  /** 未確定の区間（暫定表示用） */
  pending(): { blockId: string; speaker: string; text: string }[] {
    const out: { blockId: string; speaker: string; text: string }[] = [];
    for (const b of this.blocks.values()) {
      const text = b.text.slice(b.committedLen).trim();
      if (text) out.push({ blockId: b.uid, speaker: b.speaker, text });
    }
    return out;
  }

  // -------------------------------------------------------------------------

  private newBlock(key: string, speaker: string): BlockState {
    const gen = (this.generation.get(key) ?? 0) + 1;
    this.generation.set(key, gen);
    return {
      key,
      uid: gen === 1 ? key : `${key}#${gen}`,
      speaker,
      text: "",
      committedLen: 0,
      safeLen: 0,
      revisingOffset: null,
      pendingSince: null,
      lastUpdate: 0,
    };
  }

  /** 要素が別の発言に使い回された: 前の内容の未確定分を確定してから作り直す */
  private recycle(b: BlockState, speaker: string, t: number): BlockState {
    this.stats.recycled++;
    if (b.text.length > b.committedLen) this.commit(b, b.text.length, b.revisingOffset !== null ? "revision" : "flush");
    const nb = this.newBlock(b.key, speaker);
    nb.lastUpdate = t;
    this.blocks.set(b.key, nb);
    return nb;
  }

  private commit(b: BlockState, upto: number, reason: Utterance["reason"]): void {
    const offset = b.revisingOffset ?? b.committedLen;
    const raw = b.text.slice(b.committedLen, upto);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    const start = b.pendingSince ?? b.lastUpdate;
    b.committedLen = upto;
    b.revisingOffset = null;
    b.pendingSince = upto < b.text.length ? b.lastUpdate : null;
    if (!text && reason !== "revision") return;
    this.emitUtterance(b, reason === "revision" ? offset : offset + lead, text, start, b.lastUpdate, reason);
  }

  private emitUtterance(
    b: BlockState,
    offset: number,
    text: string,
    start: number,
    end: number,
    reason: Utterance["reason"],
  ): void {
    const u: Utterance = { blockId: b.uid, offset, speaker: b.speaker, text, start, end, reason };
    if (text && reason !== "revision") {
      const n = normalize(text);
      const dup = this.recent.some(
        (r) => r.blockId !== u.blockId && normalize(r.text) === n && Math.abs(r.end - u.end) <= this.opts.dedupeWindowMs,
      );
      if (dup) {
        this.stats.duplicates++;
        return;
      }
    }
    this.stats.emitted++;
    this.recent.push(u);
    this.emit(u);
  }
}
