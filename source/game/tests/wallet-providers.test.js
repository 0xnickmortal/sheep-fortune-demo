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
test('OKX mobile wrappers are listed once and the announced provider handles the connection',async()=>{
 const announced=provider({isOkxWallet:true,isMetaMask:true}),alias=provider({isOKExWallet:true,isMetaMask:true}),shim=provider({isMetaMask:true});
 const host=Object.assign(new EventTarget(),{okxwallet:alias,ethereum:shim});let calls=0;
 for(const p of [announced,alias,shim])p.request=async()=>{calls++;return [];};
 host.addEventListener('eip6963:requestProvider',()=>announce(host,announced,'OKX Wallet','com.okex.wallet'));
 const wallets=createWalletRegistry(host,storage());
 wallets.discover();wallets.discover();assert.equal(calls,0);
 assert.deepEqual(wallets.list().map(w=>w.name),['OKX Wallet']);
 wallets.select(wallets.list()[0].provider);assert.equal(wallets.current(),announced);
 await chooseWalletAccount(wallets.current());assert.equal(calls,1);
});
test('Binance announcement is not duplicated by an isMetaMask compatibility proxy',()=>{
 const announced=provider({isMetaMask:true}),shim=provider({isMetaMask:true});
 const host=Object.assign(new EventTarget(),{ethereum:shim});
 host.addEventListener('eip6963:requestProvider',()=>announce(host,announced,'Binance Wallet','com.binance.wallet'));
 const wallets=createWalletRegistry(host,storage());
 assert.deepEqual(wallets.list().map(w=>w.name),['Binance Wallet']);
 assert.equal(wallets.current(),announced);
});
test('an unidentified legacy wallet is not labelled MetaMask from its compatibility flag alone',()=>{
 const p=provider({isMetaMask:true}),wallets=createWalletRegistry(Object.assign(new EventTarget(),{ethereum:p}),storage());
 assert.deepEqual(wallets.list().map(w=>w.name),['浏览器钱包']);assert.equal(wallets.current(),p);
});
test('older mobile wallet namespaces take precedence over generic MetaMask compatibility flags',()=>{
 for(const [namespace,name] of [['okxwallet','OKX Wallet'],['binancew3w','Binance Wallet'],['BinanceChain','Binance Wallet']]){
  const native=provider(),host=Object.assign(new EventTarget(),{ethereum:provider({isMetaMask:true}),[namespace]:namespace==='binancew3w'?{ethereum:native}:native});
  const wallets=createWalletRegistry(host,storage());
  assert.deepEqual(wallets.list().map(w=>w.name),[name]);assert.equal(wallets.current(),native);
 }
});
test('late announcements replace duplicate legacy choices without changing a selected provider mid-session',()=>{
 const alias=provider({isOkxWallet:true}),announced=provider(),s=storage();
 const host=Object.assign(new EventTarget(),{okxwallet:alias,ethereum:provider({isMetaMask:true})});
 const wallets=createWalletRegistry(host,s);wallets.select(alias);
 announce(host,announced,'OKX Wallet','com.okx');
 assert.equal(wallets.list().length,1);assert.equal(wallets.list()[0].provider,announced);
 assert.equal(wallets.current(),alias);
 host.addEventListener('eip6963:requestProvider',()=>announce(host,announced,'OKX Wallet','com.okx'));
 assert.equal(createWalletRegistry(host,s).current(),announced);
});
test('real multiple wallets remain selectable even when a mobile compatibility proxy is present',()=>{
 const okx=provider(),binance=provider({isMetaMask:true}),mm=provider({isMetaMask:true});
 const host=Object.assign(new EventTarget(),{ethereum:provider({isMetaMask:true}),okxwallet:provider({isOkxWallet:true})});
 host.addEventListener('eip6963:requestProvider',()=>{
  announce(host,okx,'OKX Wallet','com.okex');announce(host,binance,'Binance Wallet','com.binance.wallet');announce(host,mm,'MetaMask','io.metamask');
 });
 const wallets=createWalletRegistry(host,storage());
 assert.deepEqual(wallets.list().map(w=>w.name),['OKX Wallet','Binance Wallet','MetaMask']);
 assert.equal(wallets.current(),null);
 for(const p of [okx,binance,mm]){wallets.select(p);assert.equal(wallets.current(),p);}
});
test('different announced sessions are not merged just because their display names match',()=>{
 const host=new EventTarget(),wallets=createWalletRegistry(host,storage()),a=provider(),b=provider();
 announce(host,a,'Same name','com.wallet.a');announce(host,b,'Same name','com.wallet.b');
 assert.equal(wallets.list().length,2);
});
test('duplicate announcement UUID cannot replace an existing provider',()=>{
 const host=new EventTarget(),wallets=createWalletRegistry(host,storage()),a=provider(),b=provider();
 for(const p of [a,b])host.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{provider:p,info:{name:'Wallet',rdns:'com.wallet',uuid:'same-session'}}}));
 assert.equal(wallets.list().length,1);assert.equal(wallets.list()[0].provider,a);
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
