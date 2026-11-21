# Meeting Partner 企画書（v0.1 ドラフト）

最終更新: 2026-11-21

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

## 参考
- Google Meet REST API release notes: https://developers.google.com/workspace/meet/release-notes
- Meet Media API get started: https://developers.google.com/workspace/meet/media-api/guides/get-started
- Recall.ai Sending Chat Messages: https://docs.recall.ai/docs/chat-messages
- Recall.ai Output Media: https://docs.recall.ai/docs/stream-media
- Puppeteer Google Meet bot（Recall.ai blog）: https://www.recall.ai/blog/puppeteer-google-meet-bot
- meeto (PyPI): https://pypi.org/project/meeto/
