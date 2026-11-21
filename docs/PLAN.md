# Meeting Partner 企画書（v0.2）

最終更新: 2026-11-21


## 0. 決定事項（2026-11-21）
| 項目 | 決定 |
|---|---|
| 利用者 | 自分用（社外配布しない） |
| Bot 基盤 | 自作（ブラウザ自動操作） |
| 資料の出力先 | Google ドキュメント |
| アバター | 2D |

以下 §7 以降が、この決定に基づく具体設計。§3 の案A（SaaS）は不採用。

## 1. コンセプト
Google Meet に「参加者」として入り、会話を聞きながら
1. リアルタイム要約
2. 資料化（議事録・決定事項・ToDo・図表）
3. チャットでの会話参加（質問への回答、論点整理、補足情報の提示）

を行う AI 会議パートナー。最終形ではチャットに加えて **アバター（映像＋音声）** として発言する。

## 2. 技術的前提（調査結果）

| 項目 | 状況 | 根拠 |
|---|---|---|
| Meet Media API（公式のリアルタイム音声/映像取得） | **2027-01-15 にエンドポイント停止予定**。2026-10-28 告知。新規申込は終了済み | Google Meet REST API release notes（検索結果経由で確認、ページ本文は本環境から直接取得できず） |
| Meet REST API / Meet Add-ons SDK | GA・継続サポート。ただし会議中チャットへの投稿メソッドは見当たらない | 同上 / Meet API v2 リファレンス（検索結果） |
| 公式 API で会議中チャット投稿 | 確認できず（Google Chat API は別製品のスペース向け） | Google Chat API ドキュメント（検索結果） |
| ボット基盤 SaaS（Recall.ai 等） | Meet 対応ボット、チャット送信 API、Output Media（Web ページをボットのカメラ/マイクとして配信）を提供 | Recall.ai docs（検索結果。ページ本文は本環境から未取得） |
| 自前ブラウザボット（Puppeteer/Playwright） | 実績あり。ただし headless 検知・UI 変更・ログインセッション失効/CAPTCHA が保守課題 | 各 OSS / ブログ（検索結果） |

**結論:** 公式 API だけでは「会議に入って聞く＋チャットで話す＋アバターで映る」は実現できない（Media API は停止予定）。
→ **ボット参加型（SaaS もしくは自前ブラウザボット）** が現実的な唯一の路線。

## 3. アーキテクチャ案

```
[Google Meet]
   │  (ボットが参加者として join)
   ▼
[Meeting Bot 層]  ← 案A: Recall.ai 等のSaaS / 案B: 自前 Playwright ボット
   │ 音声ストリーム          ▲ チャット投稿 / アバター映像・音声
   ▼                         │
[STT（話者分離つき）]        │
   │ テキスト＋話者           │
   ▼                         │
[Core: 会話理解エンジン (LLM)] ──┤
   ├─ ローリング要約（数十秒〜数分単位）
   ├─ 決定事項 / ToDo / 論点 抽出
   ├─ 発言判断（いつ・何を言うか）
   ▼
[資料化]  → Google Docs / Notion / Markdown へ逐次書き出し
[アバター層（Phase 3）] → TTS ＋ 映像生成 → Output Media で配信
```

### 案A vs 案B（Meeting Bot 層）
| | 案A: SaaS（Recall.ai 等） | 案B: 自前ブラウザボット |
|---|---|---|
| 立ち上げ速度 | 速い | 遅い |
| 保守 | ベンダー任せ | Meet の UI 変更・ボット検知への追随が必要 |
| コスト | 従量課金（要見積り） | インフラ＋人件費 |
| アバター配信 | Output Media 機能あり | 仮想カメラ/マイク実装が必要 |

推奨: **PoC は案A**、事業化時にコスト次第で案B を検討。

## 4. フェーズ計画

### Phase 0: 検証（1〜2週）
- Bot SaaS の無料枠で Meet 参加・文字起こし取得・チャット送信を検証
- 日本語 STT の精度・遅延比較
- 録音/AI 参加に関する社内ルール・同意フローの整理

### Phase 1: 聞く・まとめる（MVP）
- ボット参加 → リアルタイム文字起こし
- ローリング要約をWeb ダッシュボードに表示
- 会議終了時に議事録（要約・決定事項・ToDo・担当者）を自動生成し Docs/Notion へ保存

### Phase 2: チャットで参加
- 呼びかけ（例: 「パートナー、今の論点まとめて」）に応答
- 発言ポリシー: 呼ばれたときのみ / 定期要約 / 能動提案 の3モード
- 会議中チャットの読み取り → 質問に回答

### Phase 3: アバター化
- TTS で音声発話 → 2D/3D アバター映像を Output Media で配信
- 割り込み制御（人が話している間は黙る、ターンテイキング）
- 低遅延化（応答開始まで目標値を Phase 0 の計測結果から設定）

## 5. 主要リスク
- **プラットフォーム依存**: 公式 API の制約・方針変更（Media API 停止のような事例）
- **同意・プライバシー**: 録音・AI 参加の告知、データ保存期間、社外参加者への配慮
- **発言品質**: 不要な割り込み・誤情報。Phase 2 は「呼ばれたら答える」から開始
- **遅延**: STT → LLM → TTS → 映像 の多段パイプライン

## 6. 未決事項（要判断）
- 想定ユーザー（自分用 / 社内 / 外販）
- Bot 基盤: SaaS か自前か
- 資料の出力先（Google Docs / Notion / その他）
- アバターの表現（2D イラスト / 3D / 実写風）と声
- 予算感

## 7. 自作構成の具体設計

### 7.1 全体像
```
[自宅PC or VPS（Linux）]
 ├─ Chrome（headed, Xvfb 上） ← Playwright で操作。ボット専用 Google アカウントでログイン済みプロファイル
 │    ├─ Meet 字幕(DOM) を監視 ─────────┐  ※第一案
 │    ├─ 音声 → PulseAudio 仮想デバイス ──┤  ※字幕が使えない時の代替: STT へ
 │    ├─ チャット欄: 読み取り / 投稿（DOM 操作）
 │    └─ カメラ: getUserMedia を差し替え → <canvas> の 2D アバター映像（Phase 3）
 ├─ Core（Node.js / TypeScript）
 │    ├─ 発話ログ（話者名・時刻・本文）
 │    ├─ 要約ループ（約1分ごと） → Claude API
 │    ├─ 呼びかけ検知 → 返答生成 → チャット投稿
 │    └─ Google Docs API で議事録ドキュメントを逐次更新
 └─ ローカル Web 画面（要約・ToDo をリアルタイム表示、ボットの手動停止）
```
言語は Playwright と相性のよい **TypeScript（Node.js）** を推奨。

### 7.2 文字起こし: Meet 字幕の DOM 読み取りを第一案に
- Meet の字幕は日本語に対応（Google Workspace Updates 2022-12、Meet ヘルプ）。
- 利点: 話者名つきで取得でき、STT 費用ゼロ、音声取り回し不要。
- 欠点: DOM 構造は非公開で変わり得る → セレクタを1ファイルに集約し、壊れたら即検知するヘルスチェックを置く。
- 代替: 音声を仮想デバイスで取り出し Google Cloud Speech-to-Text v2（Chirp 2 は ja-JP のストリーミングに「Limited」対応、話者分離は非対応）に送る。Phase 0 で両者の精度・遅延を比較する。

### 7.3 Meet への参加
- **ボット専用の Google アカウント**を用意し、ログイン済み Chrome プロファイルを使い回す（headless はボット検知で弾かれる報告あり → Xvfb 上の通常 Chrome で動かす）。
- 自分がホストなので、ボットの参加リクエストは自分で承認する。
- Google カレンダーの予定から Meet URL を取得し自動参加（Phase 1 後半）。
- 注意: ブラウザ自動操作は Google の利用規約上グレーになり得る。自分用・自分の会議に限定して運用する。

### 7.4 LLM（Claude API）
- モデル: 既定は `claude-opus-5-5`。要約は `effort: "low"`〜`"medium"` から始めて品質を見て調整。費用を下げたい場合は Sonnet / Haiku への切替を後で判断（評価して決める）。
- 要約ループ: system（固定の指示・会議メタ情報）→ messages に発話ログを **追記のみ** で積む → プロンプトキャッシュが効く構造にする。時刻などの可変値を system に入れない。
- 出力は構造化出力（JSON スキーマ）で「要約 / 決定事項 / ToDo（担当・期限）/ 未解決論点」を受け取り、Docs に反映。
- チャット返答はストリーミングで生成し、完成した文をチャットに投稿。
- 拒否（`stop_reason: "refusal"`）は必ずハンドリング。

### 7.5 Google ドキュメント出力
- 会議開始時に「議事録テンプレ」から新規ドキュメント作成（Drive API copy）。
- 要約ループごとに Docs API `documents.batchUpdate` で各セクションを置換更新。
- 終了時に最終版（全体要約・決定事項・ToDo・全文ログへのリンク）を確定。

### 7.6 チャット参加（Phase 2）
- トリガー: チャットまたは発話に「パートナー」等の呼び名が含まれる時のみ返答（初期設定）。
- 投稿はチャット欄 DOM への入力＋送信。連投防止のレート制限を入れる。
- 将来モード: 「5分ごとに要約を投稿」「論点の抜けを指摘」を個別にON/OFF。

### 7.7 2D アバター（Phase 3）
- ページ読み込み前に `getUserMedia` を差し替え、`<canvas>.captureStream()` を返す（一般的な手法。Meet で動くかは Phase 0 で要検証）。
- 2D 表現は段階的に: ①静止画＋口パク（音量に連動）→ ②Live2D 等で表情・まばたき。
- 音声: TTS の音声を Web Audio で合成し、同じく差し替えたマイクトラックに流す。
- 既知の注意点: スクリプト注入が遅いと差し替えが効かない／バックグラウンドタブではフレームが止まる可能性。

### 7.8 Phase 0 の検証項目（実機で確認が必要）
1. ボットアカウントで Xvfb 上の Chrome から Meet に参加できるか
2. 字幕 DOM から話者名＋日本語テキストを安定して取れるか（遅延も計測）
3. チャット欄への投稿・読み取りができるか
4. canvas の映像をボットのカメラとして映せるか
5. Docs API で更新できるか（OAuth 設定）

※ この検証はボット用 Google アカウントと、実際に Meet を開ける実行環境（自宅PCなど）が必要。本クラウド環境では Google ログインが必要な検証はできない。

## 参考
- Google Meet REST API release notes: https://developers.google.com/workspace/meet/release-notes
- Meet Media API get started: https://developers.google.com/workspace/meet/media-api/guides/get-started
- Recall.ai Sending Chat Messages: https://docs.recall.ai/docs/chat-messages
- Recall.ai Output Media: https://docs.recall.ai/docs/stream-media
- Puppeteer Google Meet bot（Recall.ai blog）: https://www.recall.ai/blog/puppeteer-google-meet-bot
- meeto (PyPI): https://pypi.org/project/meeto/
- Meet 字幕の対応言語（Meet ヘルプ）: https://support.google.com/meet/answer/9300310
- Meet 字幕の言語追加（Workspace Updates 2022-12）: https://workspaceupdates.googleblog.com/2022/12/more-languages-for-captions-and-translated-captions-in-google-meet.html
- Chirp 2（Speech-to-Text v2）: https://docs.cloud.google.com/speech-to-text/docs/models/chirp-2
- canvas.captureStream による仮想カメラ（Mozilla WebRTC blog）: https://blog.mozilla.org/webrtc/enhancing-webcam-using-capturestream/
- Dyte device emulator: https://dyte.io/blog/open-sourcing-dytes-device-emulator
