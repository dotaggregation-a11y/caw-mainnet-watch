const fs = require('fs');
// mainnet: { ... } を括弧の対応で切り出す（ネストした L1/L2/L2b に対応）
const block = (t) => {
  const i = t.search(/\bmainnet\s*:\s*\{/);
  if (i < 0) return '';
  let d = 0, s = t.indexOf('{', i);
  for (let j = s; j < t.length; j++) {
    if (t[j] === '{') d++;
    else if (t[j] === '}' && --d === 0) return t.slice(s, j + 1);
  }
  return '';
};
const addrs = (t) => {
  const out = new Map();
  for (const m of block(t).matchAll(/([A-Za-z0-9_]+)\s*:\s*['"`](0x[0-9a-fA-F]{40})['"`]/g))
    if (m[1] !== 'MintableCaw') out.set(m[1] + '@' + m[2].toLowerCase(), `${m[1]}=${m[2]}`);
  return out;
};
const prev = addrs(fs.readFileSync('/tmp/old.ts', 'utf8'));
const cur = addrs(fs.readFileSync('/tmp/new.ts', 'utf8'));
for (const [k, v] of cur) if (!prev.has(k)) console.log(v);
