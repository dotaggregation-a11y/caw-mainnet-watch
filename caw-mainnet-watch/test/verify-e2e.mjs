// verify-bytecode.mjs の動作確認（anvil 上に実際にデプロイして判定させる）
//   前提: anvil が 127.0.0.1:8545 で起動済み、CAW=<Caw checkout>, DEPS=<依存 node_modules の親>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWalletClient, createPublicClient, http, encodeDeployData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
const require = createRequire(import.meta.url);
const solc = require('solc');

const CAW = process.env.CAW, DEPS = process.env.DEPS, RPC = 'http://127.0.0.1:8545';
const acct = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const wallet = createWalletClient({ account: acct, chain: foundry, transport: http(RPC) });
const pub = createPublicClient({ chain: foundry, transport: http(RPC) });

// ソースを差し替えた偽リポジトリを作る
function fakeRepo(tag, edit) {
  const dir = `/tmp/claude-0/fake-${tag}/solidity`;
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  fs.cpSync(path.join(CAW, 'solidity/contracts'), path.join(dir, 'contracts'), { recursive: true });
  if (edit) edit(dir);
  return path.dirname(dir);
}
function build(repo, file, name) {
  const SOL = path.join(repo, 'solidity');
  const input = { language: 'Solidity', sources: { [`contracts/${file}.sol`]: { content: fs.readFileSync(`${SOL}/contracts/${file}.sol`, 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.bytecode.linkReferences'] } } } };
  const imp = p => { const f = p.startsWith('contracts/') ? `${SOL}/${p}` : `${DEPS}/node_modules/${p}`; return fs.existsSync(f) ? { contents: fs.readFileSync(f, 'utf8') } : { error: 'nf ' + p }; };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: imp }));
  const errs = (out.errors || []).filter(e => e.severity === 'error'); if (errs.length) throw new Error(errs[0].formattedMessage);
  return out.contracts[`contracts/${file}.sol`][name];
}
async function deploy(c, args = []) {
  const hash = await wallet.deployContract({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}
function verify(repo, extra) {
  try { return execFileSync('node', [path.resolve('verify/verify-bytecode.mjs'), '--repo', repo, '--rpc', RPC, '--deps', DEPS, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { return e.stdout; }
}

const orig = fakeRepo('orig');
const tampered = fakeRepo('tampered', d => {          // ロジック変更（バックドア相当）
  const f = `${d}/contracts/CawNetworkManager.sol`;
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('uint32 public nextInstanceId = 1;', 'uint32 public nextInstanceId = 2;'));
});
const commented = fakeRepo('comment', d => {          // コメントだけ変更
  const f = `${d}/contracts/CawNetworkManager.sol`;
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('contract CawNetworkManager', '// audit note\ncontract CawNetworkManager'));
});

const BB = '0x000000000000000000000000000000000000bEEF';
const aOrig = await deploy(build(orig, 'CawNetworkManager', 'CawNetworkManager'), [BB]);
const aTamp = await deploy(build(tampered, 'CawNetworkManager', 'CawNetworkManager'), [BB]);
const aComm = await deploy(build(commented, 'CawNetworkManager', 'CawNetworkManager'), [BB]);
const aLib  = await deploy(build(orig, 'SessionMessageParser', 'SessionMessageParser'));
const aEOA  = '0x00000000000000000000000000000000DeaDBeef';

console.log('== 本物のソースで検証（期待: EXACT / MISMATCH(初期値改ざん) / CODE(コメントのみ) / EXACT(ライブラリ) / NO_CODE）');
console.log(verify(CAW, ['--addr', `CawNetworkManager=${aOrig}`, '--addr', `CawNetworkManager=${aTamp}`,
  '--addr', `CawNetworkManager=${aComm}`, '--addr', `SessionMessageParser=${aLib}`, '--addr', `CawNetworkManager=${aEOA}`]));
console.log('== 名前を伏せて識別（期待: CawNetworkManager / SessionMessageParser）');
console.log(verify(CAW, ['--identify', aOrig, aLib]));
