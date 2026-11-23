/**
 * プロジェクト直下の .env を読み込む（API キーなど）。.env は .gitignore 済み。見本は .env.example。
 * Node.js 標準の process.loadEnvFile を使う。既に環境変数が設定されていればそちらを優先する。
 */
import fs from "node:fs";
import path from "node:path";

export function loadEnv(file = path.resolve(".env")): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

/** 必須の環境変数を取り出す。無ければ設定方法を示して終了する */
export function requireEnv(name: string): string {
  loadEnv();
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(
      `${name} が設定されていません。プロジェクト直下の .env に「${name}=...」と書いてください（見本: .env.example）。`,
    );
    process.exit(1);
  }
  return v;
}
