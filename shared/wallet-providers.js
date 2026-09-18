// EIP-6963 discovery; provider names are plain text, never HTML or remote icons.
// https://eips.ethereum.org/EIPS/eip-6963
const STORAGE_KEY = 'sheep-wallet-provider-v1';
const errorCode = e => Number(e?.data?.originalError?.code ?? e?.cause?.code ?? e?.code);
const unsupported = e => [4200, -32601, -32602, -32004].includes(errorCode(e)) || /unsupported|not supported|not implemented|method.*not found/i.test(e?.message || '');

export function createWalletRegistry(host, storage) {
  const entries = [], listeners = new Set();
  let selected = null, preferred = '';
  try { preferred = storage?.getItem(STORAGE_KEY) || ''; } catch {}
  function add(provider, info = {}) {
    if (typeof provider?.request !== 'function') return;
    if (!info || typeof info !== 'object') info = {};
    const existing = entries.find(entry => entry.provider === provider);
    if (existing) {
      if (info.rdns && !existing.announced) Object.assign(existing, metadata(provider, info));
      else return;
    } else entries.push({ provider, ...metadata(provider, info) });
    for (const listener of listeners) listener();
  }
  function metadata(provider, info) {
    const fallback = provider.isOkxWallet || provider.isOKExWallet ? 'OKX Wallet' : provider.isCoinbaseWallet ? 'Coinbase Wallet' : provider.isTrust || provider.isTrustWallet ? 'Trust Wallet' : provider.isMetaMask ? 'MetaMask' : '浏览器钱包';
    const name = typeof info.name === 'string' ? info.name.trim().slice(0, 60) || fallback : fallback;
    const key = typeof info.rdns === 'string' && info.rdns.length < 200 ? info.rdns : 'legacy:' + fallback;
    return { name, key, announced: !!info.rdns };
  }
  function discover() {
    host.dispatchEvent(new Event('eip6963:requestProvider'));
    for (const provider of Array.isArray(host.ethereum?.providers) ? host.ethereum.providers : []) add(provider);
    add(host.okxwallet); add(host.ethereum);
  }
  host.addEventListener('eip6963:announceProvider', event => add(event.detail?.provider, event.detail?.info));
  discover();
  return {
    list: () => entries.slice(), discover,
    current() {
      if (selected) return selected;
      if (preferred) return entries.find(entry => entry.key === preferred)?.provider || null;
      // Preserve existing signed sessions created before the wallet selector.
      return host.ethereum?.request ? host.ethereum : null;
    },
    select(provider) {
      const entry = entries.find(value => value.provider === provider);
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
