// The server-backed homepage uses the same red skin as GitHub Pages.
// Keep the server API enabled: never copy the static build's local-backend meta.
export function serverSkinPage(html) {
  return html.replace('<a href="/">经典红金</a>', '')
    .replaceAll('href="/red/"', 'href="/"')
    .replace('<title>红运当头 · 羊年大吉</title>', '<title>羊年大吉转盘</title>');
}
