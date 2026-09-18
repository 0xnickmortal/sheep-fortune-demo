// EIP-6963 discovery; provider names are plain text, never HTML or remote icons.
// https://eips.ethereum.org/EIPS/eip-6963
const STORAGE_KEY = 'sheep-wallet-provider-v1';
const errorCode = e => Number(e?.data?.originalError?.code ?? e?.cause?.code ?? e?.code);
const unsupported = e => [4200, -32601, -32602, -32004].includes(errorCode(e)) || /unsupported|not supported|not implemented|method.*not found/i.test(e?.message || '');

export function createWalletRegistry(host, storage) {
  const announced = [], listeners = new Set();
  let selected = null, preferred = '';
  try { preferred = storage?.getItem(STORAGE_KEY) || ''; } catch {}
  const usable = provider => typeof provider?.request === 'function';
  const names = { okx: 'OKX Wallet', binance: 'Binance Wallet', coinbase: 'Coinbase Wallet', trust: 'Trust Wallet', metamask: 'MetaMask' };
  function brand(provider, info = {}) {
    const rdns = typeof info.rdns === 'string' ? info.rdns.toLowerCase() : '';
    const name = typeof info.name === 'string' ? info.name.toLowerCase().replace(/[\s_-]/g, '') : '';
    if (/^com\.(okx|okex)(\.|$)/.test(rdns) || /^(okx|okex)wallet$/.test(name)) return 'okx';
    if (/^com\.binance(\.|$)/.test(rdns) || /^binance(web3)?wallet$/.test(name)) return 'binance';
    if (/^com\.coinbase(\.|$)/.test(rdns)) return 'coinbase';
    if (/^com\.trustwallet(\.|$)/.test(rdns)) return 'trust';
    if (/^io\.metamask(\.|$)/.test(rdns)) return 'metamask';
    // An announced identity takes precedence over compatibility flags.
    if (rdns) return '';
    if (provider.isOkxWallet || provider.isOKExWallet) return 'okx';
    if (provider.isBinance || provider.isBinanceWallet) return 'binance';
    if (provider.isCoinbaseWallet) return 'coinbase';
    if (provider.isTrust || provider.isTrustWallet) return 'trust';
    // isMetaMask alone is not proof of a MetaMask installation.
    return '';
  }
  function entries() {
    const result = announced.slice();
    function supplement(provider, walletBrand = brand(provider || {})) {
      if (!usable(provider) || result.some(entry => entry.provider === provider)) return;
      if (walletBrand && result.some(entry => entry.brand === walletBrand)) return;
      const name = names[walletBrand] || '浏览器钱包';
      result.push({ provider, name, key: 'legacy:' + name, brand: walletBrand, announced: false });
    }
    // Wallet-specific namespaces may wrap the same provider announced via 6963.
    supplement(host.okxwallet, 'okx');
    supplement(host.binancew3w?.ethereum, 'binance');
    supplement(host.BinanceChain, 'binance');
    for (const provider of Array.isArray(host.ethereum?.providers) ? host.ethereum.providers : []) {
      // Use unidentified legacy entries only if no 6963 discovery is available.
      if (brand(provider || {}) || !announced.length) supplement(provider);
    }
    // window.ethereum can be a compatibility proxy, even with isMetaMask=true.
    // Never invent an extra wallet from that proxy when identified wallets exist.
    if (brand(host.ethereum || {}) || !result.length) supplement(host.ethereum);
    return result;
  }
  function notify() {
    for (const listener of listeners) listener();
  }
  function add(provider, info) {
    if (!usable(provider) || !info || typeof info !== 'object') return;
    const rdns = typeof info.rdns === 'string' && info.rdns.length < 200 ? info.rdns : '';
    if (!rdns) return;
    const uuid = typeof info.uuid === 'string' ? info.uuid : '';
    if (announced.some(entry => entry.provider === provider || (uuid && entry.uuid === uuid))) return;
    const walletBrand = brand(provider, info), fallback = names[walletBrand] || '浏览器钱包';
    const name = typeof info.name === 'string' ? info.name.trim().slice(0, 60) || fallback : fallback;
    announced.push({ provider, name, key: rdns, uuid, brand: walletBrand, announced: true });
    notify();
  }
  function discover() {
    host.dispatchEvent(new Event('eip6963:requestProvider'));
    notify();
  }
  host.addEventListener('eip6963:announceProvider', event => add(event.detail?.provider, event.detail?.info));
  discover();
  return {
    list: entries, discover,
    current() {
      if (selected) return selected;
      const available = entries();
      if (preferred) return available.find(entry => entry.key === preferred || (preferred === 'legacy:' + entry.name))?.provider || null;
      // Preserve existing signed sessions created before the wallet selector.
      // Do not silently choose a different wallet when several are available.
      return available.find(entry => entry.provider === host.ethereum)?.provider || (available.length === 1 ? available[0].provider : null);
    },
    select(provider) {
      const entry = entries().find(value => value.provider === provider);
      if (!entry) throw Error('钱包不可用，请重新选择');
      selected = provider; preferred = entry.key;
      try { storage?.setItem(STORAGE_KEY, preferred); } catch {}
    },
    clear() { selected = null; preferred = ''; try { storage?.removeItem(STORAGE_KEY); } catch {} },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export async function chooseWalletAccount(provider) {
  try { await provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }); }
  catch (error) {
    // Cancellation must stop login, not silently reuse the previously allowed account.
    if (errorCode(error) === 4001) throw Error('已取消连接钱包');
    if (errorCode(error) === -32002) throw Error('钱包中还有待确认的请求，请打开钱包完成或取消');
    if (!unsupported(error)) throw error;
  }
}

export async function releaseWallet(provider) {
  if (!provider?.request) return;
  let timer;
  try {
    await Promise.race([
      provider.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }),
      new Promise(resolve => { timer = setTimeout(resolve, 2000); }),
    ]);
  } catch { /* The server session is already revoked; older wallets lack this RPC. */ }
  finally { clearTimeout(timer); }
}
