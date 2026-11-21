# Meeting Partner 企画書（v0.3）

最終更新: 2026-11-21

## 0. 決定事項
| 項目 | 決定 |
|---|---|
| 利用者 | 自分用（社外配布しない。自分がホストの会議でのみ使用） |
| Bot 基盤 | 自作（Playwright でブラウザ操作） |
| 実行環境 | 自宅 PC（または自宅 LAN 内の Linux 機）を第一候補 |
| 文字起こし | Meet 字幕の DOM 読み取りを第一案、音声 STT を予備案 |
| 資料の出力先 | Google ドキュメント（**会議終了時に一括生成**＋手動ボタンで随時生成） |
| 会議中の表示 | ローカル Web 画面でリアルタイム表示 |
| アバター | 2D |
| 実装言語 | TypeScript（Node.js） |

## 1. コンセプト
自分の Google Meet に「参加者」として入り、会話を聞きながら
1. リアルタイム要約
2. 資料化（議事録・決定事項・ToDo）
3. チャットでの会話参加

を行う AI 会議パートナー。最終形では **2D アバター（映像＋音声）** として発言する。

## 2. 技術的前提（調査結果）

| 項目 | 状況 | 根拠 |
|---|---|---|
| Meet Media API（公式のリアルタイム音声/映像取得） | 2027-01-15 にエンドポイント停止予定（2026-10-28 告知、新規申込終了） | Google Meet REST API release notes（検索結果経由。本文は本環境から直接取得できず） |
| Meet REST API / Add-ons SDK | GA・継続。ただし会議中チャットへの投稿メソッドは見当たらない | Meet API v2 リファレンス（検索結果） |
| 自作ブラウザボット | 実例あり。headless 検知、UI 変更、ログイン失効・CAPTCHA が保守課題 | 各 OSS / ブログ（検索結果） |
| Meet 字幕の日本語対応 | 対応 | Meet ヘルプ、Workspace Updates 2022-12 |

**結論:** 公式 API では要件を満たせないため、自作ブラウザボットで実現する。

## 3. アーキテクチャ

```
[自宅 PC（Linux）]
 ├─ Chrome（headed, Xvfb 上） ← Playwright で操作。ボット専用アカウントのログイン済みプロファイル
 │    ├─ 字幕 DOM 監視 → 確定処理（§4.2）
 │    ├─ 音声 → PulseAudio 仮想デバイス → VAD / 予備 STT（Phase 3 で必須）
 │    ├─ チャット欄: 読み取り / 投稿（DOM 操作）
 │    └─ カメラ/マイク: getUserMedia 差し替え → canvas の 2D アバター＋TTS 音声（Phase 3）
 ├─ Core（Node.js / TypeScript）
 │    ├─ 確定発話ログ（話者・時刻・本文）※ボット自身の発話は除外
 │    ├─ 要約ループ（約1分ごと, 軽量モデル）
 │    ├─ 長時間対策: 約30分ごとに古い生ログを区間要約へ圧縮
 │    ├─ 呼びかけ検知 → 返答生成 → チャット投稿
 │    └─ 議事録清書（上位モデル）→ Google Docs 生成（終了時 / 手動）
 └─ ローカル Web 画面（要約・決定事項・ToDo のリアルタイム表示、Docs 出力ボタン、ボット停止）
```

## 4. 設計詳細

### 4.1 Meet への参加
- ボット専用 Google アカウントを作成。**リカバリ用メール・電話番号はメインアカウントと分離**し、停止時の波及を防ぐ。
- headless はボット検知で弾かれる報告があるため、Xvfb 上の通常 Chrome を使う。
- 自分がホストなので、参加リクエストは自分で承認する。
- 入室後に UI 操作で「字幕 ON → 言語を日本語に設定」を自動実行する（既定状態は Phase 0 で確認）。
- 注意: ブラウザ自動操作は Google 利用規約上グレーになり得る。自分の会議に限定して運用する。

### 4.2 字幕の取得と確定処理
- 字幕は発話中に書き換わる前提で設計する。DOM の変化をそのまま記録しない。
- **確定条件（初期案）**: ①話者が切り替わった、②同じ字幕ブロックが一定時間（例: 2秒）更新されない。どちらかで1発話として確定する。
- 確定前のテキストはローカル画面の「暫定表示」にだけ使う。
- DOM のセレクタは1ファイルに集約。取得が止まったら検知して画面に警告する。
- **合否基準（Phase 0）**: 実際の自分の会議（専門用語を含む）で、字幕ログから作った要約に致命的な誤りがないこと。満たさない場合は STT 予備案（Google Cloud Speech-to-Text v2 / Chirp 2: ja-JP ストリーミングは「Limited」対応、話者分離なし）と比較する。

### 4.3 LLM（Claude API）
| 役割 | 頻度 | モデル（初期案） |
|---|---|---|
| ローリング要約・決定事項/ToDo 抽出 | 約1分ごと | `claude-haiku-5-5` または `claude-sonnet-5-5` |
| 呼びかけへのチャット返答 | 随時 | `claude-sonnet-5-5`（ストリーミング） |
| 最終議事録の清書 | 終了時 / 手動 | `claude-opus-5-5` |

- 最終的なモデルは Phase 0〜1 で実際の会議ログを使い、品質・遅延・費用を測って決める。
- プロンプト構造: 固定の system（指示・会議メタ情報）→ 発話ログを追記。時刻などの可変値は system に入れず、キャッシュが効くようにする。
- 長時間会議対策: 約30分ごとに古い生ログを区間要約に置き換え、入力量の増加を抑える（置き換え時はキャッシュが作り直しになる点は許容）。
- 出力は構造化出力（JSON スキーマ）で「要約 / 決定事項 / ToDo（担当・期限）/ 未解決論点」。
- `stop_reason: "refusal"` を必ずハンドリング。

### 4.4 Google ドキュメント出力
- 会議中の確認はローカル Web 画面で行う。Docs の逐次更新はしない（Docs API は文字位置ベースのため、セクション単位の置換を繰り返す実装は不具合が出やすい）。
- 会議終了時（または手動ボタン）に、清書結果から **新規ドキュメントを1回で生成** する。
- 構成: 全体要約 / 決定事項 / ToDo / 未解決論点 / 全文ログ。

### 4.5 チャット参加（Phase 2）
- 呼び名（例:「パートナー」）がチャットまたは発話に含まれる時だけ返答する。
- チャット欄への入力・送信は DOM 操作。連投防止のレート制限を入れる。
- 追加モード（個別 ON/OFF）: 定期要約の投稿、論点の抜けの指摘。

### 4.6 2D アバターと音声発話（Phase 3）
- カメラ: ページ読み込み前に `getUserMedia` を差し替え、`canvas.captureStream()` を返す。①静止画＋口パク（音量連動）→ ②Live2D 等で表情・まばたき。
- 音声: TTS 音声を Web Audio で差し替えマイクトラックに流す。
- **自己発話ループ防止**: ボット自身の字幕・チャットを話者名で除外する。加えて「ボットが発話中・直後に確定した発話」には反応しない。
- **割り込み制御**: 字幕は表示まで遅れがあるため、ターンテイキングの判断には使わない。PulseAudio から取った会議音声に VAD（発話区間検出）をかけ、人が話している間は発話しない。
- 既知の注意点: 差し替えスクリプトの注入が遅いと効かない。バックグラウンドタブではフレームが止まる可能性がある。

## 5. フェーズ計画

### Phase 0: 実機検証（自宅 PC で実施）
1. ボットアカウントで Xvfb 上の Chrome から Meet に参加できるか
2. 入室後に字幕 ON・日本語設定を自動化できるか
3. 字幕 DOM から話者名＋日本語テキストを取れるか。連続発話時の DOM の書き換わり方を記録し、§4.2 の確定ロジックを決める（字幕の遅延も計測）
4. §4.2 の合否基準を満たすか（実際の会議で要約を試作）
5. チャット欄への投稿・読み取りができるか
6. canvas の映像をボットのカメラとして映せるか
7. Docs API でドキュメントを生成できるか（OAuth 設定）
8. Xvfb 上の Chrome を1〜2時間動かした時のメモリ・CPU 負荷

### Phase 1: 聞く・まとめる（MVP）
- 参加 → 字幕取得・確定 → 約1分ごとの要約をローカル画面に表示
- 終了時に清書して Google ドキュメントを生成

### Phase 2: チャットで参加
- 呼びかけへの返答、会議中チャットの読み取り

### Phase 3: 2D アバター化
- 静止画＋口パク → Live2D、TTS、VAD による割り込み制御

## 6. 主要リスク
- **UI 変更・ボット検知**: Meet の DOM 変更、ログイン失効・CAPTCHA。セレクタ集約と異常検知で早く気付けるようにする。
- **規約・アカウント**: 自動操作は規約上グレー。ボットアカウントを分離して運用する。
- **字幕精度**: 専門用語の誤変換。Phase 0 の合否基準で判断する。
- **遅延**: 字幕 → LLM → TTS → 映像 の多段パイプライン。
- **費用**: 要約ループのモデル選定を実測で決める。

## 7. 未確認事項（Phase 0 で確認）
以下はレビューで指摘された想定で、実機で確認していない。
- 入室直後の字幕の既定状態（OFF か、言語は何か）
- 字幕の表示遅延の実測値
- データセンター IP（VPS）からのログイン・参加が家庭回線より弾かれやすいか（そのため自宅 PC を第一候補にしている）

## 参考
- Google Meet REST API release notes: https://developers.google.com/workspace/meet/release-notes
- Meet Media API get started: https://developers.google.com/workspace/meet/media-api/guides/get-started
- Puppeteer Google Meet bot（Recall.ai blog）: https://www.recall.ai/blog/puppeteer-google-meet-bot
- meeto (PyPI): https://pypi.org/project/meeto/
- Meet 字幕の対応言語（Meet ヘルプ）: https://support.google.com/meet/answer/9300310
- Meet 字幕の言語追加（Workspace Updates 2022-12）: https://workspaceupdates.googleblog.com/2022/12/more-languages-for-captions-and-translated-captions-in-google-meet.html
- Chirp 2（Speech-to-Text v2）: https://docs.cloud.google.com/speech-to-text/docs/models/chirp-2
- canvas.captureStream による仮想カメラ（Mozilla WebRTC blog）: https://blog.mozilla.org/webrtc/enhancing-webcam-using-capturestream/
- Dyte device emulator: https://dyte.io/blog/open-sourcing-dytes-device-emulator
