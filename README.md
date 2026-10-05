# caw-mainnet-watch

GilgameshCaw/Caw の Mainnet 移行を検知する監視一式。

| 段 | 何を見るか | どこで動くか | 通知 |
|---|---|---|---|
| L0b | deployer `0xF713…4a95` の残高変動（±0.05 ETH 以上） | Worker（1分） | 入金＝デプロイ前兆 |
| L1' | deployer が**新たに消費した nonce** の CREATE アドレスにコードがあるか（chain 1 / 8453 / 42161） | Worker（1分） | 🚨 コントラクト生成 |
| L2 | `client/src/abi/deployments.ts` の `mainnet` ブロックに MintableCaw 以外が追加 | GitHub Actions（10分） | 🚨 公式アドレス記載 |

**移行完了の判定：L1' と L2 で同じアドレスが出たとき。**

## セットアップ

```bash
npm i
npx wrangler kv namespace create CAW_KV   # 出力の id を wrangler.toml に貼る
npx wrangler secret put DISCORD_WEBHOOK
npx wrangler deploy
```

L2 は `.github/workflows/caw-mainnet-l2-watch.yml` を自分の監視用リポジトリに置き、
Secrets に `DISCORD_WEBHOOK` を登録する。

## 設計上の要点

- CREATE アドレスにコードが入るのは、その nonce の tx が確定した後だけ。
  そのため「現在 nonce から前方」ではなく、「前回の nonce から現在の nonce まで」に消費された帯を確認する。
- 平常時（nonce が変化しない間）は、チェーンごとに RPC 1 回、KV 書き込み 0 回。
  無料プランの制限（50 サブリクエスト、1,000 writes/日）に収まる。
- 1 回の実行で確認するのは最大 50 nonce。大量デプロイが起きても、残りは次の実行で続きから確認するので取りこぼさない。
- RPC が 15 回連続で失敗したら 1 回だけ警告する（監視が止まっていることに気づけるように）。
- 前提：mainnet でも同じ deployer EOA を使うこと（未確認）。別の EOA が使われた場合は、L2 が主な検知手段になる。

## テスト

```bash
node test/sim.mjs   # RPC/KV モックで 初回→変化なし→入金→送金→デプロイ を再現
```

## バイトコード検証（本当に「このコード」がデプロイされたか）

`verify/verify-bytecode.mjs` は、リポジトリのソースを hardhat と同じ設定（solc 0.8.30、runs=1、viaIR、cancun）でコンパイルし、チェーン上のコードと照合する。照合は次の2段で行う。

1. **実行コード**（`eth_getCode`）を比べる。immutable、リンクされたライブラリのアドレス、ライブラリ自身のアドレス、CBOR メタデータは比較前に伏せ、伏せた値は別途表示する。
2. **作成コード**（デプロイ tx の input）を比べる。コンストラクタや初期値の改ざんは、実行コードには現れない。こちらで初めて検出できる。最後にコンストラクタ引数をデコードして表示する。

| 判定 | 意味 |
|---|---|
| ✅ EXACT | コメントまで含めてソースが完全一致 |
| 🟡 CODE | 実行されるコードは一致。違うのはコメントやパスだけ |
| ❌ MISMATCH | そのコミットのソースからは作られていない |
| ⚪ NO_CODE | そのアドレスにコードがない |

```bash
node verify/verify-bytecode.mjs --repo ./Caw --deps ./deps --rpc $L1_RPC --addr CawNetworkManager=0x...
node verify/verify-bytecode.mjs --repo ./Caw --deps ./deps --rpc $L1_RPC --identify 0x... 0x...   # 名前が不明なとき
```

依存ライブラリは Caw の `solidity/package-lock.json` と同じバージョンにそろえる必要がある。バージョンが違うとバイトコードも変わる。

**自動実行：** `caw-mainnet-l2-watch` が mainnet アドレスの追加を検知すると、`caw-mainnet-verify` が起動する。チェーンごとの検証結果は Discord に届く。手動で実行するときは、ref にタグ（`v2.0.0` など）を指定する。
Secrets：`L1_RPC` / `L2_RPC` / `L2B_RPC`（アーカイブ対応のものを推奨）、`ETHERSCAN_API_KEY`（任意）。

テスト：`anvil &` を起動してから、`CAW=<checkout> DEPS=<deps> node test/verify-e2e.mjs` を実行する。

## 通知先

どの通知先も、Secret（Worker の場合は `wrangler secret put`、Actions の場合はリポジトリの Secrets）を登録したものだけが使われる。複数を同時に使える。

| 宛先 | 設定 | 備考 |
|---|---|---|
| Discord | `DISCORD_WEBHOOK` | |
| Slack | `SLACK_WEBHOOK` | Incoming Webhook |
| Telegram | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | @BotFather で Bot を作る |
| LINE | `LINE_CHANNEL_TOKEN` + `LINE_TO` | Messaging API を使う（LINE Notify は 2025 年 3 月に終了） |
| ntfy | `NTFY_TOPIC`（`NTFY_URL` は任意） | アカウント不要。🚨 の通知は最優先度で届く。トピック名は推測されにくいものにする |
| GitHub Issue | Variables に `GITHUB_ISSUE=1` | Actions の通知だけが対象。GitHub のメールやアプリで通知が届き、記録も残る |

1つの宛先で送信に失敗しても、ほかの宛先には送られる。
