import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureBscNetwork, bscWallet, loginBscWallet, BSC_NETWORK, readWalletTokenBalance, compactTokenBalance } from '../public/shared/wallet-network.js';
const address = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40);
function wallet({ chain = '0x1', missing = false, rejects = false, unchanged = false, nested = false, changeOnSign, changeAccountOnSign = false, changeOnSwitch = false } = {}) {
  const calls = [], events = [], accounts = [address]; let added = !missing;
  const provider = { calls, events, accounts, async request({ method, params }) {
    calls.push(method);
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return accounts;
    if (method === 'wallet_switchEthereumChain') {
      assert.equal(params[0].chainId, '0x38');
      if (rejects) throw { code: 4001 };
      if (!added) throw nested ? { code: -32603, data: { originalError: { code: 4902 } } } : { code: 4902 };
      if (!unchanged) chain = '0x38';
      if (changeOnSwitch) accounts[0] = other;
      return null;
    }
    if (method === 'wallet_addEthereumChain') { assert.deepEqual(params[0], BSC_NETWORK); added = true; return null; }
    if (method === 'personal_sign') { events.push('signed'); if (changeOnSign) chain = changeOnSign; if (changeAccountOnSign) accounts[0] = other; return 'test-signature'; }
    throw Error('Unexpected method ' + method);
  } };
  return provider;
}
test('already on BSC: no switch or add request', async () => {
  const p = wallet({ chain: '0x38' }); assert.equal(await bscWallet(p, { connect: true }), address);
  assert.ok(!p.calls.includes('wallet_switchEthereumChain')); assert.ok(!p.calls.includes('wallet_addEthereumChain'));
});
test('Ethereum and BSC testnet both switch to verified BSC mainnet', async () => {
  for (const chain of ['0x1', '0x61']) { const p = wallet({ chain }); await ensureBscNetwork(p); assert.equal(await p.request({method:'eth_chainId'}), '0x38'); }
});
test('missing BSC, including mobile nested 4902: add then explicitly switch', async () => {
  for (const nested of [false, true]) {
    const p = wallet({ missing: true, nested }); await ensureBscNetwork(p);
    assert.deepEqual(p.calls.filter(x => x.startsWith('wallet_')), ['wallet_switchEthereumChain','wallet_addEthereumChain','wallet_switchEthereumChain']);
  }
});
test('cancelled or ineffective switch never reaches login challenge or signing', async () => {
  for (const options of [{ rejects: true }, { unchanged: true }]) {
    const p = wallet(options); let apiCalls = 0;
    await assert.rejects(loginBscWallet(p, () => { apiCalls++; }), /取消|尚未切换/);
    assert.equal(apiCalls, 0); assert.ok(!p.calls.includes('personal_sign'));
  }
});
test('simultaneous network checks only ask the wallet to switch once', async () => {
  const p = wallet(); await Promise.all([ensureBscNetwork(p), ensureBscNetwork(p), ensureBscNetwork(p)]);
  assert.equal(p.calls.filter(x => x === 'wallet_switchEthereumChain').length, 1);
});
test('login uses the account selected after switching networks', async () => {
  const p = wallet({ changeOnSwitch: true }); const seen = [];
  const result = await loginBscWallet(p, async (path, data) => {
    seen.push(path);
    if (path === '/auth/challenge') { assert.equal(data.address, other); assert.ok(p.calls.includes('wallet_switchEthereumChain')); return { message:'Sign in', challengeId:'id' }; }
    assert.equal(data.signature,'test-signature'); return { wallet: other };
  });
  assert.equal(result.wallet, other); assert.deepEqual(seen, ['/auth/challenge','/auth/verify']);
});
test('chain or account change during signature stops verification', async () => {
  for (const options of [{ changeOnSign:'0x1' }, { changeAccountOnSign:true }]) {
    const p = wallet(options), seen = [];
    await assert.rejects(loginBscWallet(p, async path => { seen.push(path); return { message:'Sign in', challengeId:'id' }; }), /网络已改变|钱包已切换/);
    assert.deepEqual(seen, ['/auth/challenge']);
  }
});
test('payment guard rejects a different wallet after network switching', async () => {
  await assert.rejects(bscWallet(wallet({ changeOnSwitch:true }), { expectedAddress:address }), /钱包已切换/);
});
test('unsupported switch and pending request give actionable messages', async () => {
  for (const [code, message] of [[4200, /不支持自动切链/],[-32002,/待确认的请求/]]) {
    await assert.rejects(ensureBscNetwork({ async request({method}) { if(method==='eth_chainId')return '0x1';throw {code}; } }), message);
  }
});

function balanceWallet({ units = 123456789012345678901234567n, change, chain = '0x38', accounts = [address], result } = {}) {
  const calls = [];
  return { calls, async request({ method, params }) {
    calls.push(method);
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_accounts') return accounts;
    if (method === 'eth_call') {
      assert.deepEqual(params, [{ to: other, data: '0x70a08231' + address.slice(2).padStart(64, '0') }, 'latest']);
      if (change === 'chain') chain = '0x1';
      if (change === 'account') accounts = [other];
      return result ?? '0x' + units.toString(16).padStart(64, '0');
    }
    throw Error('Unexpected signing or switching request: ' + method);
  } };
}
const balanceInput = { address, token: other, decimals: 18 };
test('holdings use balanceOf with exact decimals, without signing, authorizing or switching', async () => {
  const provider = balanceWallet();
  assert.equal(await readWalletTokenBalance(provider, balanceInput), '123456789.012345678901234567');
  assert.deepEqual(provider.calls, ['eth_chainId', 'eth_accounts', 'eth_call', 'eth_chainId', 'eth_accounts']);
  for (const [units, decimals, expected] of [[0n,18,'0'],[1n,18,'0.000000000000000001'],[123n,0,'123'],[1230000n,6,'1.23']]) {
    assert.equal(await readWalletTokenBalance(balanceWallet({ units }), { ...balanceInput, decimals }), expected);
  }
});
test('wrong network or account and changes during balance reads never return stale holdings', async () => {
  for (const options of [{ chain:'0x1' },{ accounts:[other] },{ accounts:[] },{ change:'chain' },{ change:'account' }]) {
    await assert.rejects(readWalletTokenBalance(balanceWallet(options), balanceInput), /BSC|切换|重新连接/);
  }
});
test('missing contract, invalid decimals and invalid RPC responses are errors, not zero holdings', async () => {
  for (const input of [{ token:null },{ token:'0x'+'0'.repeat(40) },{ decimals:-1 },{ decimals:'18' }]) {
    await assert.rejects(readWalletTokenBalance(balanceWallet(), { ...balanceInput, ...input }), /信息暂不可用/);
  }
  for (const result of ['0x','0x0','not-a-balance']) await assert.rejects(readWalletTokenBalance(balanceWallet({result}), balanceInput), /无法读取/);
});
test('compact wallet holdings use 万/亿 without floating point rounding or false zero', () => {
  for (const [input, expected] of [['0','0'],['100','100'],['10.12','10.12'],['9999.999999','9999.9999'],['10000','1万'],['780000','78万'],['1000000','100万'],['1234567.89','123.45万'],['990000000','9.9亿'],['12345678901234567890','123456789012.34亿'],['0.000000000000000001','<0.0001'],['bad','—']]) {
    assert.equal(compactTokenBalance(input), expected);
  }
});
