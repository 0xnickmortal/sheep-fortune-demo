// Keep feedback in the caller's dialog. Wallet WebViews may reject clipboard
// access, omit the API, or leave its promise pending indefinitely.
export function selectCopyText(field) {
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, field.value.length);
  } catch { /* The visible, read-only field remains available for long-press. */ }
}

export async function copyText(text, field, { navigator = globalThis.navigator, timeoutMs = 1500 } = {}) {
  let timer;
  try {
    if (typeof navigator?.clipboard?.writeText !== 'function') throw Error('Clipboard unavailable');
    // Invoke within the click handler, before any await, for Safari activation.
    await Promise.race([
      navigator.clipboard.writeText(text),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Clipboard timeout')), timeoutMs); }),
    ]);
    return true;
  } catch {
    // Use the existing field inside the modal. A temporary input appended to
    // document.body would be inert while a native <dialog> is open.
    selectCopyText(field);
    try { return field.ownerDocument.execCommand('copy') === true; }
    catch { return false; }
  } finally { clearTimeout(timer); }
}
