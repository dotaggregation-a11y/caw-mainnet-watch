// CAW mainnet 移行監視（L0b + L1'）— Cloudflare Workers, cron 1分
//
// 原理：CREATE アドレス keccak(rlp([deployer, nonce])) にコードが入るのは
// 「その nonce の tx が確定した後」だけ。したがって見るべきは
// 現在 nonce より「前」の、前回から新たに消費された nonce 帯 [prev, current)。
// 現在 nonce から前方を走査しても原理的に永久に 0 件。
import { getContractAddress, toFunctionSelector } from 'viem';

// CawNetworkManager の公開カウンタ（solidity/contracts/CawNetworkManager.sol:95, :158）
const SEL_NEXT_NETWORK = toFunctionSelector('nextNetworkId()');
const SEL_NEXT_INSTANCE = toFunctionSelector('nextInstanceId()');
const call = (to, data) => ['eth_call', [{ to, data }, 'latest']];
const u = (hex) => (hex && hex !== '0x' ? Number(BigInt(hex)) : null);

const DEPLOYER = '0xF71338f3eAa483aA66125598B09BA1988e694a95';
const CHAINS = [
  ['L1',  'https://ethereum-rpc.publicnode.com'], // chain 1
  ['L2',  'https://mainnet.base.org'],            // chain 8453
  ['L2b', 'https://arb1.arbitrum.io/rpc'],        // chain 42161
];
const SCAN_PER_RUN = 50;        // 1回で確認する nonce 数の上限（残りは次回に続きから）
const BALANCE_DELTA_ETH = 0.05; // L0b: この額以上の残高変動で通知
const ERROR_ALERT_AFTER = 15;   // 連続失敗がこの回数に達したら1回だけ通知

// JSON-RPC バッチ（1サブリクエストで複数呼び出し。無料プランの50サブリクエスト制限対策）
async function rpcBatch(url, calls, tolerant = false) {
  const body = calls.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const res = await r.json();
  if (!Array.isArray(res)) throw new Error('batch unsupported: ' + JSON.stringify(res).slice(0, 200));
  const out = [];
  for (const x of res) {
    if (x.error) {
      if (!tolerant) throw new Error(JSON.stringify(x.error));
      out[x.id] = null;                    // 例：関数を持たない契約への eth_call は revert
    } else out[x.id] = x.result;
  }
  return out;
}

// 設定された宛先すべてに送る（wrangler secret で登録したものだけ使われる）。
// notify/notify.sh（GitHub Actions 側）と同じ環境変数名。
async function notify(env, content) {
  const json = (url, body, headers = {}) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const [title, ...rest] = content.split('\n');
  const urgent = /🚨|⚠️/.test(content);
  const jobs = [];
  if (env.DISCORD_WEBHOOK) jobs.push(json(env.DISCORD_WEBHOOK, { content: content.slice(0, 1900) }));
  if (env.SLACK_WEBHOOK) jobs.push(json(env.SLACK_WEBHOOK, { text: content }));
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)
    jobs.push(json(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: env.TELEGRAM_CHAT_ID, text: content.slice(0, 4000), disable_web_page_preview: true }));
  if (env.LINE_CHANNEL_TOKEN && env.LINE_TO)
    jobs.push(json('https://api.line.me/v2/bot/message/push',
      { to: env.LINE_TO, messages: [{ type: 'text', text: content.slice(0, 4900) }] },
      { authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}` }));
  if (env.NTFY_TOPIC)
    jobs.push(json(env.NTFY_URL || 'https://ntfy.sh',
      { topic: env.NTFY_TOPIC, title, message: rest.join('\n') || title, priority: urgent ? 5 : 3 }));
  const res = await Promise.allSettled(jobs);
  const failed = res.filter(r => r.status === 'rejected' || !r.value.ok).length;
  if (failed) console.log(`notify: ${failed}/${jobs.length} 件の送信に失敗`);
}

// 段階 E：mainnet の CawNetworkManager でネットワーク作成・ノード登録が始まったか
async function checkRegistry(key, url, env, mgr, nn, ni, msgs) {
  const prev = JSON.parse((await env.CAW_KV.get(`reg:${key}`)) || '{"nn":1,"ni":1}');
  if (nn === prev.nn && ni === prev.ni) return;
  const parts = [];
  if (nn > prev.nn) parts.push(`ネットワーク作成 ${nn - prev.nn}件（nextNetworkId ${prev.nn}→${nn}）`);
  if (ni > prev.ni) parts.push(`ノード登録 ${ni - prev.ni}件（instanceId ${prev.ni}〜${ni - 1}）`);
  msgs.push(`🛰 [${key}] CawNetworkManager ${mgr}\n` + parts.join('\n'));
  await env.CAW_KV.put(`reg:${key}`, JSON.stringify({ nn, ni }));
}

async function checkChain(key, url, env, msgs) {
  const mgr = await env.CAW_KV.get(`mgr:${key}`);
  const [nonceHex, weiHex, nnHex, niHex] = await rpcBatch(url, [
    ['eth_getTransactionCount', [DEPLOYER, 'latest']],
    ['eth_getBalance', [DEPLOYER, 'latest']],
    ...(mgr ? [call(mgr, SEL_NEXT_NETWORK), call(mgr, SEL_NEXT_INSTANCE)] : []),
  ]);
  if (mgr) await checkRegistry(key, url, env, mgr, u(nnHex), u(niHex), msgs);
  const nonce = parseInt(nonceHex, 16);
  const eth = Number(BigInt(weiHex)) / 1e18;

  // L0b: 入金の前兆（入金は nonce を動かさないので残高でしか見えない）
  // KV への書き込みは変化時のみ（毎分書くと無料枠 1,000 writes/日 を超える）
  const prevEthRaw = await env.CAW_KV.get(`bal:${key}`);
  if (prevEthRaw === null || Math.abs(eth - Number(prevEthRaw)) >= BALANCE_DELTA_ETH) {
    if (prevEthRaw !== null) {
      msgs.push(`[${key}] deployer 残高 ${Number(prevEthRaw).toFixed(4)} → ${eth.toFixed(4)} ETH`);
    }
    await env.CAW_KV.put(`bal:${key}`, String(eth));
  }

  // L1': 新たに消費された nonce 帯だけを確認
  const prevRaw = await env.CAW_KV.get(`nonce:${key}`);
  if (prevRaw === null) {                 // 初回はベースライン記録のみ
    await env.CAW_KV.put(`nonce:${key}`, String(nonce));
    return;
  }
  const prev = Number(prevRaw);
  if (nonce <= prev) return;              // 変化なし（通常はここで終わり：RPC 1回のみ）

  const end = Math.min(nonce, prev + SCAN_PER_RUN);
  const targets = [];
  for (let n = prev; n < end; n++) {
    targets.push({ n, addr: getContractAddress({ from: DEPLOYER, nonce: BigInt(n) }) });
  }
  const codes = await rpcBatch(url, targets.map(t => ['eth_getCode', [t.addr, 'latest']]));
  const hits = targets
    .map((t, i) => ({ ...t, code: codes[i] }))
    .filter(t => t.code && t.code !== '0x')
    .map(t => `nonce=${t.n} ${t.addr} (${(t.code.length - 2) / 2} bytes)`);

  // 生成された契約のうち nextInstanceId() に応答するもの＝CawNetworkManager を特定して記録
  const created = targets.filter((t, i) => codes[i] && codes[i] !== '0x');
  if (!mgr && created.length) {
    const probe = await rpcBatch(url, created.map(t => call(t.addr, SEL_NEXT_INSTANCE)), true);
    const found = created.find((t, i) => probe[i] && probe[i].length === 66 && u(probe[i]) >= 1);
    if (found) {
      await env.CAW_KV.put(`mgr:${key}`, found.addr);
      msgs.push(`📍 [${key}] CawNetworkManager を特定: nonce=${found.n} ${found.addr}（以後ノード登録を監視）`);
    }
  }

  msgs.push(hits.length
    ? `🚨 [${key}] コントラクト生成 ${hits.length}件 (nonce ${prev}→${end})\n${hits.join('\n')}`
    : `[${key}] deployer tx ${end - prev}件（コントラクト生成なし＝送金等）`);
  await env.CAW_KV.put(`nonce:${key}`, String(end));
}

export default {
  async scheduled(_event, env) {
    const msgs = [];
    const errors = [];
    for (const [key, url] of CHAINS) {
      try { await checkChain(key, url, env, msgs); }
      catch (e) { errors.push(`${key}: ${e.message}`); }
    }
    if (msgs.length) await notify(env, 'CAW mainnet watch\n' + msgs.join('\n'));

    // 沈黙の故障対策：RPC が落ち続けても気づけるように
    const fails = Number((await env.CAW_KV.get('fails')) || 0);
    if (errors.length) {
      const f = fails + 1;
      await env.CAW_KV.put('fails', String(f));
      if (f === ERROR_ALERT_AFTER) await notify(env, `⚠️ 監視が ${f} 回連続で失敗\n${errors.join('\n')}`);
    } else if (fails) {
      await env.CAW_KV.put('fails', '0');
    }
  },
};
