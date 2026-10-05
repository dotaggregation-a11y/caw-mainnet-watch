import worker from '/home/claude/caw-mainnet-watch/src/index.js';
import { getContractAddress } from 'viem';
import { toFunctionSelector } from 'viem';
const NN=toFunctionSelector('nextNetworkId()');
const D='0xF71338f3eAa483aA66125598B09BA1988e694a95';
const kv=new Map(); let writes=0;
const env={ DISCORD_WEBHOOK:'https://hook', CAW_KV:{get:async k=>kv.has(k)?kv.get(k):null, put:async(k,v)=>{writes++;kv.set(k,v)}}};
let state={nonce:4, wei:89591000000000000n, deployed:new Set(), mgr:null, nn:1, ni:1}; const sent=[];
globalThis.fetch=async(url,opt)=>{
  const b=JSON.parse(opt.body);
  if(url==='https://hook'){sent.push(b.content);return {ok:true}}
  const isL1=url.includes('ethereum');
  const hex=n=>'0x'+n.toString(16).padStart(64,'0');
  const res=b.map(c=>c.method==='eth_call'
    ? (isL1&&c.params[0].to.toLowerCase()===state.mgr
        ? {id:c.id,result:hex(c.params[0].data===NN?state.nn:state.ni)}
        : {id:c.id,error:{code:3,message:'execution reverted'}})
    : ({id:c.id,result:
    c.method==='eth_getTransactionCount'?'0x'+(isL1?state.nonce:0).toString(16):
    c.method==='eth_getBalance'?'0x'+(isL1?state.wei:0n).toString(16):
    (isL1&&state.deployed.has(c.params[0].toLowerCase())?'0x6080'+'00'.repeat(100):'0x')}));
  return {ok:true,json:async()=>res};
};
const run=async(label)=>{sent.length=0; await worker.scheduled({},env); console.log(`--- ${label}: writes=${writes}\n`+(sent.join('\n')||'(通知なし)'));};
await run('初回ベースライン');
await run('変化なし');
state.wei=5n*10n**18n; await run('入金 5 ETH');
state.nonce=6; await run('送金2件（コード生成なし）');
for(const n of [6,7,8]) state.deployed.add(getContractAddress({from:D,nonce:BigInt(n)}).toLowerCase());
state.mgr=getContractAddress({from:D,nonce:7n}).toLowerCase();
state.nonce=10; await run('デプロイ 3件＋送金1件（nonce7=Manager）');
await run('変化なし');
state.nn=2; await run('Uruk ネットワーク作成');
state.ni=4; await run('ノード 3件登録');
