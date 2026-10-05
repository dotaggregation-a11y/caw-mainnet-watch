#!/usr/bin/env node
// チェーン上のコントラクトが、リポジトリのソース（特定コミット）から本当にビルドされたものかを検証する。
//
//   node verify/verify-bytecode.mjs --repo ./Caw --rpc <RPC_URL> \
//        --addr CawNetworkManager=0x... --addr CawProfile=0x...
//   node verify/verify-bytecode.mjs --repo ./Caw --rpc <RPC_URL> --identify 0x... 0x...
//
// 判定:
//   EXACT     … 実行コードもメタデータハッシュも一致＝コメントまで含めソースが完全一致
//   CODE      … 実行コードは一致、メタデータのみ相違（コメント・パス等の差。ロジックは同一）
//   MISMATCH  … 実行コードが異なる＝そのコミットのソースからは作られていない
//   NO_CODE   … そのアドレスにコードが無い
//
// 比較前に次を正規化する（どちらもデプロイ時にしか決まらない値）:
//   - immutable 変数の埋め込み位置（例：CawNetworkManager の buyAndBurnAddress）→ 値は別途表示
//   - リンクされたライブラリのアドレス（例：SessionMessageParser）→ 値は別途表示
//   - 末尾の CBOR メタデータ（ソースのハッシュを含む）→ EXACT/CODE の区別に使う
//
// ビルド設定は solidity/hardhat.config.js と同一（deploy.js は hardhat の成果物をデプロイする）:
//   solc 0.8.30 / optimizer runs=1 / viaIR / evmVersion cancun
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const SETTINGS = {
  optimizer: { enabled: true, runs: 1 },
  viaIR: true,
  evmVersion: 'cancun',
  outputSelection: { '*': { '*': ['evm.deployedBytecode.object', 'evm.deployedBytecode.linkReferences',
    'evm.deployedBytecode.immutableReferences', 'evm.bytecode.object', 'evm.bytecode.linkReferences', 'abi'], '': ['ast'] } },
};
const SOLC_VERSION = '0.8.30';

// ---------- 引数 ----------
const args = process.argv.slice(2);
const opt = { addr: [], identify: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--repo') opt.repo = args[++i];
  else if (a === '--rpc') opt.rpc = args[++i];
  else if (a === '--addr') opt.addr.push(args[++i]);
  else if (a === '--deps') opt.deps = args[++i];
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--identify') { while (args[i + 1] && !args[i + 1].startsWith('--')) opt.identify.push(args[++i]); }
}
if (!opt.repo || !opt.rpc || (!opt.addr.length && !opt.identify.length)) {
  console.error('usage: --repo <Caw checkout> --rpc <url> (--addr Name=0x.. ... | --identify 0x.. ...)');
  process.exit(2);
}
const SOL = path.resolve(opt.repo, 'solidity');
// 依存（@openzeppelin 等）は repo の node_modules、無ければ --deps の node_modules から解決
const DEP_ROOTS = [path.join(SOL, 'node_modules'), opt.deps && path.resolve(opt.deps, 'node_modules')].filter(Boolean);

// ---------- コンパイル ----------
function readImport(p) {
  const tries = p.startsWith('contracts/') ? [path.join(SOL, p)] : DEP_ROOTS.map(r => path.join(r, p));
  for (const f of tries) if (fs.existsSync(f)) return { contents: fs.readFileSync(f, 'utf8') };
  return { error: 'not found: ' + p };
}

async function compile(names) {
  const solc = require('solc');
  if (!solc.version().startsWith(SOLC_VERSION)) throw new Error(`solc ${SOLC_VERSION} が必要（現在 ${solc.version()}）`);
  // hardhat と同じソースユニット名 "contracts/X.sol" を使う（メタデータハッシュも一致させるため）
  const sources = {};
  for (const n of names) {
    const rel = `contracts/${n}.sol`;
    if (!fs.existsSync(path.join(SOL, rel))) throw new Error(`ソースが見つからない: ${rel}`);
    sources[rel] = { content: fs.readFileSync(path.join(SOL, rel), 'utf8') };
  }
  const input = { language: 'Solidity', sources, settings: SETTINGS };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: readImport }));
  const errs = (out.errors || []).filter(e => e.severity === 'error');
  if (errs.length) throw new Error(errs.map(e => e.formattedMessage).join('\n'));
  // immutable の AST id → 変数名
  const walk = (n) => { if (!n || typeof n !== 'object') return;
    if (n.nodeType === 'VariableDeclaration' && n.mutability === 'immutable') IMM_NAMES[n.id] = n.name;
    for (const v of Object.values(n)) Array.isArray(v) ? v.forEach(walk) : walk(v); };
  for (const s of Object.values(out.sources || {})) walk(s.ast);
  return out.contracts;
}
const IMM_NAMES = {};

function allContractNames() {
  return fs.readdirSync(path.join(SOL, 'contracts'))
    .filter(f => f.endsWith('.sol') && !/^(I[A-Z]|Mock)/.test(f)).map(f => f.replace(/\.sol$/, ''));
}

// ---------- RPC ----------
async function getCode(addr) {
  const r = await fetch(opt.rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [addr, 'latest'] }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result.slice(2).toLowerCase();
}

// ---------- 比較 ----------
// 末尾2バイトが CBOR メタデータ長。メタデータを切り離す
function splitMeta(hex) {
  if (hex.length < 4) return { code: hex, meta: '' };
  const len = parseInt(hex.slice(-4), 16);
  const cut = hex.length - (len + 2) * 2;
  if (len === 0 || cut < 0 || !hex.slice(cut, cut + 2).match(/^a[1-9]$/)) return { code: hex, meta: '' };
  return { code: hex.slice(0, cut), meta: hex.slice(cut) };
}

function masks(dep) {
  const m = [];
  for (const [id, refs] of Object.entries(dep.immutableReferences || {}))
    for (const { start, length } of refs) m.push({ start, length, kind: 'immutable', id });
  for (const [file, libs] of Object.entries(dep.linkReferences || {}))
    for (const [lib, refs] of Object.entries(libs))
      for (const { start, length } of refs) m.push({ start, length, kind: 'library', id: `${file}:${lib}` });
  return m;
}

function compare(onchain, dep) {
  let built = dep.object.toLowerCase();
  if (onchain.length !== built.length) return { verdict: 'MISMATCH', reason: `長さが違う（chain ${onchain.length / 2} bytes / build ${built.length / 2} bytes）` };
  const filled = {};
  const a = onchain.split(''), b = built.split('');
  // ライブラリ（SessionMessageParser 等）は先頭 PUSH20 に自分のアドレスがデプロイ時に入る
  if (built.startsWith('73' + '0'.repeat(40))) for (let i = 2; i < 42; i++) a[i] = '0';
  for (const { start, length, kind, id } of masks(dep)) {
    const s = start * 2, e = s + length * 2;
    filled[kind === 'immutable' ? `immutable ${IMM_NAMES[id] || id}` : `library ${id}`] = '0x' + onchain.slice(s, e).replace(/^0{24}(?=.{40}$)/, '');
    for (let i = s; i < e; i++) a[i] = b[i] = '0';
  }
  const A = splitMeta(a.join('')), B = splitMeta(b.join(''));
  if (A.code !== B.code) {
    let i = 0; while (A.code[i] === B.code[i]) i++;
    return { verdict: 'MISMATCH', reason: `byte ${i >> 1} から相違`, filled };
  }
  return { verdict: A.meta === B.meta ? 'EXACT' : 'CODE', filled,
    reason: A.meta === B.meta ? 'ソース（コメント含む）まで完全一致' : '実行コード一致・メタデータ（コメント/パス等）のみ相違' };
}

// ---------- 作成コード（デプロイ tx の input）の照合 ----------
// 実行コードだけでは「コンストラクタで設定される初期値・初期化処理」の改ざんを見逃す
// （実測：nextInstanceId の初期値を 1→2 にした改ざん版は実行コードが完全一致する）。
async function rpc(method, params) {
  const r = await fetch(opt.rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function findCreationTx(addr) {
  // 1) Etherscan があれば一発（ETHERSCAN_API_KEY, 任意）
  if (process.env.ETHERSCAN_API_KEY) {
    const chainId = parseInt(await rpc('eth_chainId', []), 16);
    const u = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getcontractcreation&contractaddresses=${addr}&apikey=${process.env.ETHERSCAN_API_KEY}`;
    const j = await (await fetch(u)).json();
    if (j.result?.[0]?.txHash) return j.result[0].txHash;
  }
  // 2) 二分探索：コードが現れた最初のブロックを探す（アーカイブ対応 RPC が必要）
  let lo = 0, hi = parseInt(await rpc('eth_blockNumber', []), 16);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const c = await rpc('eth_getCode', [addr, '0x' + mid.toString(16)]);
    if (c && c !== '0x') hi = mid; else lo = mid + 1;
  }
  const blk = await rpc('eth_getBlockByNumber', ['0x' + lo.toString(16), true]);
  for (const tx of blk.transactions.filter(t => !t.to)) {
    const rc = await rpc('eth_getTransactionReceipt', [tx.hash]);
    if (rc.contractAddress?.toLowerCase() === addr.toLowerCase()) return tx.hash;
  }
  return null;   // コントラクト内部からの CREATE（ファクトリ経由）など
}

async function compareCreation(addr, c) {
  const hash = await findCreationTx(addr);
  if (!hash) return { creation: 'SKIP', creationReason: 'EOA からの直接デプロイ tx が見つからない（ファクトリ経由の可能性）' };
  const input = (await rpc('eth_getTransactionByHash', [hash])).input.slice(2).toLowerCase();
  const built = c.evm.bytecode.object.toLowerCase();
  if (input.length < built.length) return { creation: 'MISMATCH', creationReason: '作成コードが短い', tx: hash };
  const a = input.slice(0, built.length).split(''), b = built.split('');
  for (const libs of Object.values(c.evm.bytecode.linkReferences || {}))
    for (const refs of Object.values(libs))
      for (const { start, length } of refs) for (let i = start * 2; i < (start + length) * 2; i++) a[i] = b[i] = '0';
  // 作成コードに埋め込まれた実行コードの CBOR メタデータ部分を伏せる（EXACT/CODE は実行コード側で判定済み）
  const meta = splitMeta(c.evm.deployedBytecode.object.toLowerCase()).meta;
  const at = meta ? built.lastIndexOf(meta) : -1;
  let metaSame = true;
  if (at >= 0) for (let i = at; i < at + meta.length; i++) { if (a[i] !== b[i]) metaSame = false; a[i] = b[i] = '0'; }
  if (a.join('') !== b.join('')) {
    let i = 0; while (a[i] === b[i]) i++;
    return { creation: 'MISMATCH', creationReason: `作成コード byte ${i >> 1} から相違（コンストラクタ/初期値が異なる）`, tx: hash };
  }
  // 末尾＝コンストラクタ引数。ABI があればデコードして表示
  const argsHex = input.slice(built.length);
  let ctorArgs = argsHex ? '0x' + argsHex : '(なし)';
  const ctor = c.abi.find(x => x.type === 'constructor');
  if (ctor && argsHex) {
    try {
      const { decodeAbiParameters } = await import('viem');
      const vals = decodeAbiParameters(ctor.inputs, '0x' + argsHex);
      ctorArgs = ctor.inputs.map((p, i) => `${p.name}=${vals[i]}`).join(', ');
    } catch {}
  }
  return { creation: metaSame ? 'EXACT' : 'CODE', tx: hash, ctorArgs };
}

// ---------- 実行 ----------
const pairs = opt.addr.map(s => { const [name, addr] = s.split('='); return { name, addr }; });
const names = opt.identify.length ? allContractNames() : [...new Set(pairs.map(p => p.name))];
const commit = (() => { try { return require('child_process').execSync('git rev-parse --short=10 HEAD', { cwd: opt.repo }).toString().trim(); } catch { return '?'; } })();
console.error(`compile ${names.length} contracts @ ${commit} (solc ${SOLC_VERSION}, runs=1, viaIR, cancun)…`);
const contracts = await compile(names);
const lookup = (n) => contracts[`contracts/${n}.sol`]?.[n];

const results = [];
for (const { name, addr } of pairs) {
  const code = await getCode(addr);
  const c = lookup(name);
  const r = !code ? { verdict: 'NO_CODE' } : !c ? { verdict: 'MISMATCH', reason: `${name} がビルドに無い` } : compare(code, c.evm.deployedBytecode);
  results.push(await withCreation({ name, addr, ...r }, c));
}

// 実行コードが一致したものだけ作成コードも照合し、総合判定に反映する
async function withCreation(r, c) {
  if (!['EXACT', 'CODE'].includes(r.verdict) || process.env.SKIP_CREATION) return r;
  try {
    Object.assign(r, await compareCreation(r.addr, c));
  } catch (e) { r.creation = 'SKIP'; r.creationReason = e.message.slice(0, 120); }
  if (r.creation === 'MISMATCH') { r.verdict = 'MISMATCH'; r.reason = r.creationReason; }
  return r;
}
for (const addr of opt.identify) {
  const code = await getCode(addr);
  if (!code) { results.push({ name: '?', addr, verdict: 'NO_CODE' }); continue; }
  let best = { name: '?', addr, verdict: 'UNKNOWN', reason: 'どのコントラクトとも一致しない' };
  for (const [file, cs] of Object.entries(contracts)) for (const [n, c] of Object.entries(cs)) {
    if (!file.startsWith('contracts/') || !c.evm.deployedBytecode.object) continue;
    const r = compare(code, c.evm.deployedBytecode);
    if (r.verdict === 'EXACT' || (r.verdict === 'CODE' && best.verdict !== 'EXACT')) best = { name: n, addr, ...r, _c: c };
  }
  const c = best._c; delete best._c;
  results.push(c ? await withCreation(best, c) : best);
}

const icon = { EXACT: '✅', CODE: '🟡', MISMATCH: '❌', NO_CODE: '⚪', UNKNOWN: '❓' };
for (const r of results) {
  console.log(`${icon[r.verdict]} ${r.verdict.padEnd(8)} ${r.name.padEnd(22)} ${r.addr}  ${r.reason || ''}`);
  for (const [k, v] of Object.entries(r.filled || {})) console.log(`      ${k} = ${v}`);
  if (r.creation) console.log(`      作成コード: ${r.creation}${r.tx ? ' tx=' + r.tx : ''}${r.creationReason && r.creation !== 'MISMATCH' ? ' ' + r.creationReason : ''}`);
  if (r.ctorArgs) console.log(`      コンストラクタ引数: ${r.ctorArgs}`);
}
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify({ commit, results }, null, 2));
process.exit(results.some(r => ['MISMATCH', 'UNKNOWN', 'NO_CODE'].includes(r.verdict)) ? 1 : 0);
