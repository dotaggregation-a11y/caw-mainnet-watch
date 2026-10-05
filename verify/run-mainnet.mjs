// deployments.ts の mainnet ブロック（L1 / L2 / L2b）を読み、チェーンごとに verify-bytecode.mjs を実行する。
//   node verify/run-mainnet.mjs --repo ./Caw --deps ./deps
//   RPC は環境変数 L1_RPC / L2_RPC / L2B_RPC（未設定ならパブリック RPC）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const repo = arg('--repo'), deps = arg('--deps');
const RPC = {
  L1: process.env.L1_RPC || 'https://ethereum-rpc.publicnode.com',
  L2: process.env.L2_RPC || 'https://mainnet.base.org',
  L2b: process.env.L2B_RPC || 'https://arb1.arbitrum.io/rpc',
};
// 既存の CAW（A Hunters Dream）はリポジトリからビルドされたものではないので対象外
const EXCLUDE = new Set(['MintableCaw']);

const src = fs.readFileSync(path.join(repo, 'client/src/abi/deployments.ts'), 'utf8');
const braceBlock = (t, re) => {
  const i = t.search(re); if (i < 0) return '';
  let d = 0; const s = t.indexOf('{', i);
  for (let j = s; j < t.length; j++) { if (t[j] === '{') d++; else if (t[j] === '}' && --d === 0) return t.slice(s, j + 1); }
  return '';
};
const mainnet = braceBlock(src, /\bmainnet\s*:\s*\{/);

let lines = [], failed = false;
for (const chain of ['L1', 'L2', 'L2b']) {
  const blk = braceBlock(mainnet, new RegExp(`\\b${chain}\\s*:\\s*\\{`));
  const pairs = [...blk.matchAll(/([A-Za-z0-9_]+)\s*:\s*['"`](0x[0-9a-fA-F]{40})['"`]/g)]
    .filter(m => !EXCLUDE.has(m[1])).map(m => `${m[1]}=${m[2]}`);
  if (!pairs.length) continue;
  const r = spawnSync('node', [path.join(import.meta.dirname, 'verify-bytecode.mjs'), '--repo', repo, '--rpc', RPC[chain],
    ...(deps ? ['--deps', deps] : []), ...pairs.flatMap(p => ['--addr', p])], { encoding: 'utf8' });
  lines.push(`[${chain}]`, (r.stdout || '').trim() || (r.stderr || '').trim().slice(-500));
  if (r.status !== 0) failed = true;
}
if (!lines.length) lines = ['mainnet ブロックに検証対象のアドレスがまだ無い'];
const out = lines.join('\n');
console.log(out);
fs.writeFileSync('verify-result.txt', out);
process.exit(failed ? 1 : 0);
