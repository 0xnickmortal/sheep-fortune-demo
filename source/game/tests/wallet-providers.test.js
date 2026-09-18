import test from 'node:test';
import assert from 'node:assert/strict';
import {createWalletRegistry, chooseWalletAccount, releaseWallet} from '../public/shared/wallet-providers.js';
const provider = flags => ({...flags,request:async()=>[]});
function storage() { const data=new Map();return {getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)}; }
function announce(host,p,name,rdns) { host.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{provider:p,info:{name,rdns}}})); }
test('discovers multiple installed wallets without requests and deduplicates legacy injection',()=>{
 const a=provider({isMetaMask:true}),b=provider({isOkxWallet:true}),host=Object.assign(new EventTarget(),{ethereum:a,okxwallet:b});
 let rpc=0;a.request=b.request=async()=>{rpc++;};
 host.addEventListener('eip6963:requestProvider',()=>{announce(host,a,'MetaMask','io.metamask');announce(host,b,'OKX Wallet','com.okx');});
 const wallets=createWalletRegistry(host,storage());
 assert.deepEqual(wallets.list().map(w=>w.name),['MetaMask','OKX Wallet']);assert.equal(rpc,0);
 wallets.discover();assert.equal(wallets.list().length,2);
 wallets.select(b);assert.equal(wallets.current(),b);assert.equal(host.ethereum,a);
});
test('remembers selected wallet across reloads and never falls back to a different provider when it is missing',()=>{
 const s=storage(),a=provider({isMetaMask:true}),b=provider({isOkxWallet:true});
 const make=()=>Object.assign(new EventTarget(),{ethereum:a,okxwallet:b});
 const first=createWalletRegistry(make(),s);first.select(b);
 assert.equal(createWalletRegistry(make(),s).current(),b);
 const absent=createWalletRegistry(Object.assign(new EventTarget(),{ethereum:a}),s);assert.equal(absent.current(),null);
 absent.clear();assert.equal(s.getItem('sheep-wallet-provider-v1'),null);
});
test('late discovery updates the selector and invalid or unknown providers cannot be selected',()=>{
 const host=new EventTarget(),wallets=createWalletRegistry(host,storage());let changes=0;
 const unsubscribe=wallets.subscribe(()=>changes++),a=provider();
 announce(host,a,'<script>alert(1)</script>','com.example');
 assert.equal(changes,1);assert.equal(wallets.list()[0].name,'<script>alert(1)</script>');
 announce(host,{},'Bad','bad');assert.equal(wallets.list().length,1);
 assert.throws(()=>wallets.select(provider()),/不可用/);
 unsubscribe();announce(host,provider(),'Another','com.another');assert.equal(changes,1);
});
test('account chooser requests only eth_accounts permissions, and cancellation never silently proceeds',async()=>{
 let request;await chooseWalletAccount({request:async r=>{request=r;return [];}});
 assert.deepEqual(request,{method:'wallet_requestPermissions',params:[{eth_accounts:{}}]});
 await assert.rejects(chooseWalletAccount({request:async()=>{throw {code:4001};}}),/取消/);
 await assert.rejects(chooseWalletAccount({request:async()=>{throw {code:-32002,message:'pending'};}}),/待确认/);
});
test('older mobile wallets fall back only for unsupported account permission methods',async()=>{
 for(const code of [4200,-32601,-32602,-32004])await chooseWalletAccount({request:async()=>{throw {code};}});
 await chooseWalletAccount({request:async()=>{throw Error('Unsupported method');}});
});
test('disconnect revokes only account access where supported; lack of RPC support does not block logout',async()=>{
 let request;await releaseWallet({request:async r=>{request=r;}});
 assert.deepEqual(request,{method:'wallet_revokePermissions',params:[{eth_accounts:{}}]});
 await releaseWallet({request:async()=>{throw {code:4200};}});await releaseWallet(null);
});
