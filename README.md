# CraftLingo

Minecraft MOD JAR、複数の JAR を含む ZIP またはフォルダーから言語ファイルを抽出し、ブラウザ内のローカルAIで日本語化して、1つのリソースパックとして書き出す React アプリです。

## 開発

```bash
npm install
npm run dev
```

品質チェックは次のコマンドで実行できます。

```bash
npm run typecheck
npm test
npm run build
```

## 対応している入力

- 複数の `.jar` を含む `.zip`
- 単体または複数の `.jar`
- `.jar` を含むフォルダー（サブフォルダーも再帰的に検索）
- `assets/<namespace>/lang/en_us.json`
- `assets/<namespace>/lang/ja_jp.json`
- 旧形式の `en_us.lang` / `en_US.lang` / `ja_jp.lang`
- Fabric、Quilt、Forge、NeoForge、legacy の主要メタデータ

同じJAR内に複数namespaceがある場合も個別に扱います。元MODに日本語が含まれる場合は既存訳を優先し、ユーザー編集だけを上書きします。

## ローカルAI

端末の機能に応じて2種類のローカルランタイムを利用します。

- LFM2.5 1.2B JP Q4_K_M（約731MB）: `@wllama/wllama` の WebAssembly / CPU 推論。WebGPU不要
- Gemma 4 E2B（標準）: `@litert-lm/core` / WebGPU
- Gemma 4 E4B（高品質）: `@litert-lm/core` / WebGPU

WebGPU非対応環境ではLFM2.5が自動選択されます。LFM2.5のGGUFはWllamaの`ModelManager` / `CacheManager`で保存・再利用し、訳文はWllamaのOpenAI互換`response_format: json_schema`で構造を制約します。初回翻訳時に選択したモデルとランタイムをダウンロードしますが、MODの内容と翻訳テキストは推論時に外部APIへ送信しません。

WllamaのWASM並列処理には`Cross-Origin-Opener-Policy: same-origin`と`Cross-Origin-Embedder-Policy: require-corp`が必要です。Viteの開発・プレビューサーバーには設定済みですが、本番配信でも同じレスポンスヘッダーを設定してください。ヘッダーがない環境では1スレッドへフォールバックします。

Android / iOSではメモリ負荷と最初の結果までの待ち時間を抑えるため、LFM2.5を`n_ctx: 4096`、`n_batch: 128`、1項目ずつのモバイル設定で実行します。

## 出力

書き出しモーダルではパック名、バージョン、対象Minecraftバージョン、任意のPNGアイコン、収録するMODを指定できます。出力ZIPには `pack.mcmeta`、`pack.png`、選択したMODの各namespaceに対応する `assets/<namespace>/lang/ja_jp.json` が含まれます。元MODに同梱済みの未変更日本語は既定では重複収録せず、「ビルトインのキーを含める」を有効にした場合だけ収録します。`pack.mcmeta` の互換形式は、選択したMinecraftバージョンから自動設定されます。
