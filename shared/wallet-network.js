// BSC mainnet metadata: https://docs.bnbchain.org/bnb-smart-chain/developers/wallet-configuration/
export const BSC_NETWORK = Object.freeze({
  chainId: '0x38', chainName: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
  blockExplorerUrls: ['https://bscscan.com'],
});
export function isBscChain(chain) { try { return BigInt(chain) === 56n; } catch { return false; } }
const switching = new WeakMap();
const codeOf = error => Number(error?.data?.originalError?.code ?? error?.cause?.code ?? error?.code);
function walletError(error) {
  const code = codeOf(error);
  if (code === 4001) return new Error('你已取消钱包操作，请切换到 BSC 主网后再继续');
  if (code === -32002) return new Error('钱包里还有待确认的请求，请打开钱包完成确认');
  if (code === 4200 || code === -32601) return new Error('此钱包不支持自动切链，请在钱包中选择 BSC 主网后重试');
  return error;
}
export async function ensureBscNetwork(provider) {
  if (!provider?.request) throw new Error('请在支持 BSC 的钱包浏览器中打开本页');
  if (switching.has(provider)) return switching.get(provider);
  const task = (async () => {
    if (isBscChain(await provider.request({ method: 'eth_chainId' }))) return;
    const change = () => provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BSC_NETWORK.chainId }] });
    try { await change(); }
    catch (error) {
      if (codeOf(error) !== 4902) throw error;
      await provider.request({ method: 'wallet_addEthereumChain', params: [structuredClone(BSC_NETWORK)] });
      // Adding a network does not necessarily select it in mobile wallets.
      if (!isBscChain(await provider.request({ method: 'eth_chainId' }))) await change();
    }
    if (!isBscChain(await provider.request({ method: 'eth_chainId' }))) throw new Error('尚未切换到 BSC 主网，请在钱包中确认后重试');
  })().catch(error => { throw walletError(error); });
  switching.set(provider, task);
  try { await task; } finally { switching.delete(provider); }
}
export async function bscWallet(provider, { connect = false, expectedAddress } = {}) {
  if (!provider?.request) throw new Error('请使用支持 BSC 的钱包浏览器');
  if (connect) {
    try { await provider.request({ method: 'eth_requestAccounts' }); } catch (error) { throw walletError(error); }
  }
  await ensureBscNetwork(provider);
  const [address] = await provider.request({ method: 'eth_accounts' });
  if (!address) throw new Error('钱包尚未连接，请重新连接钱包');
  if (expectedAddress && address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('钱包已切换，请重新签名登录');
  return address;
}
export async function loginBscWallet(provider, api) {
  const address = await bscWallet(provider, { connect: true });
  const challenge = await api('/auth/challenge', { address });
  await bscWallet(provider, { expectedAddress: address });
  const messageHex = '0x' + Array.from(new TextEncoder().encode(challenge.message), x => x.toString(16).padStart(2, '0')).join('');
  let signature;
  try { signature = await provider.request({ method: 'personal_sign', params: [messageHex, address] }); }
  catch (error) { throw walletError(error); }
  // Do not accept a signature as a successful login after an account/network change.
  if (!isBscChain(await provider.request({ method: 'eth_chainId' }))) throw new Error('签名时网络已改变，请切换到 BSC 主网后重新登录');
  const [current] = await provider.request({ method: 'eth_accounts' });
  if (current?.toLowerCase() !== address.toLowerCase()) throw new Error('钱包已切换，请重新签名登录');
  return api('/auth/verify', { challengeId: challenge.challengeId, signature });
}
