const UNIT = 10n ** 18n;
const units = amount => {
  const [whole, fraction = ''] = String(amount ?? '0').split('.');
  return BigInt(whole) * UNIT + BigInt(fraction.padEnd(18, '0'));
};
const amount = value => {
  const fraction = (value % UNIT).toString().padStart(18, '0').replace(/0+$/, '');
  return String(value / UNIT) + (fraction ? '.' + fraction : '');
};
export const referralTotal = data => amount(units(data.directEarned) + units(data.indirectEarned));

// A wallet switch invalidates in-flight reads and the notification baseline.
// The first successful read displays history without announcing it as new income.
export function createReferralMonitor({ fetchSummary, onUpdate, onCredit, onError }) {
  let owner = null, generation = 0, snapshot = null, pending = null;
  function setOwner(next) {
    next = next?.toLowerCase() || null;
    if (next === owner) return false;
    owner = next; generation++; snapshot = null; pending = null;
    return true;
  }
  function refresh() {
    if (!owner) return Promise.resolve(null);
    if (pending) return pending;
    const current = generation;
    const request = (async () => {
      try {
        const data = await fetchSummary();
        if (current !== generation) return null;
        const total = units(referralTotal(data));
        const increase = snapshot ? total - units(referralTotal(snapshot)) : 0n;
        snapshot = data;
        if (increase > 0n) onCredit?.(amount(increase));
        onUpdate(data);
        return data;
      } catch (error) {
        if (current !== generation) return null;
        onError?.(error);
        throw error;
      }
    })();
    pending = request;
    const clear = () => { if (pending === request) pending = null; };
    request.then(clear, clear);
    return request;
  }
  return { setOwner, refresh };
}
