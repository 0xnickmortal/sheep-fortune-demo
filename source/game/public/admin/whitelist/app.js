const $ = id => document.getElementById(id);
let adminKey = '', revision = 0, activeAddress = null, schema, cursor = null, busy = false;
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('invalid', error); }
function setBusy(value) { busy = value; document.querySelectorAll('button').forEach(b => b.disabled = value); }
async function api(data, after = '') {
  const response = await fetch('/api/admin/whitelist' + (after ? '?after=' + encodeURIComponent(after) : ''), {
    method: data ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit',
    headers: { Authorization: 'Bearer ' + adminKey, ...(data ? { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() } : {}) },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  let result; try { result = await response.json(); } catch { throw Error('此地址未接入游戏后端，请使用后端站点的管理入口'); }
  if (!response.ok) throw Error(result.error || '读取失败');
  return result;
}
const weights = () => [...$('probabilities').querySelectorAll('input')].map(input => {
  if (!/^\d+(?:\.\d{1,2})?$/.test(input.value)) return NaN;
  return Math.round(Number(input.value) * 100);
});
function totals() {
  const values = weights(), total = values.reduce((a, n) => a + n, 0);
  $('total').textContent = '概率合计：' + (Number.isFinite(total) ? total / 100 + '%' : '请填写有效数字');
  $('total').classList.toggle('invalid', total !== 10000);
  const net = values.reduce((s, w, i) => { const m = schema.outcomes[i].multiplierBps; return s + w * (m - (m > schema.roundFee.aboveMultiplierBps ? schema.roundFee.bps : 0)); }, 0) / 1000000;
  $('rtp').textContent = total === 10000 ? '扣转盘手续费后理论返还率：' + net.toFixed(4) + '%；白名单提现手续费：0%。' : '各档概率必须合计100%后才能保存。';
}
function edit(entry) {
  revision = entry?.revision ?? 0; activeAddress = entry?.address ?? null;
  $('wallet').value = activeAddress || ''; $('wallet').readOnly = !!activeAddress;
  $('enabled').checked = entry?.enabled ?? false;
  $('editor-title').textContent = activeAddress ? '修改地址配置' : '新增地址';
  $('probabilities').replaceChildren(...schema.outcomes.map((o, i) => {
    const label = document.createElement('label'); label.textContent = (o.multiplierBps === 0 ? '谢谢参与' : o.multiplierBps / 10000 + '×') + '（%）';
    const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '100'; input.step = '.01'; input.required = true;
    input.value = (entry?.weights ?? schema.defaultWeights)[i] / 100; input.addEventListener('input', totals); label.append(input); return label;
  })); totals();
}
function entries(rows, append = false) {
  if (!append) $('entries').replaceChildren();
  if (!append && !rows.length) $('entries').textContent = '尚未配置任何白名单。';
  for (const entry of rows) {
    const row = document.createElement('article'); row.className = 'entry';
    const detail = document.createElement('div'), wallet = document.createElement('code'), state = document.createElement('p'), note = document.createElement('small'), button = document.createElement('button');
    wallet.textContent = entry.address; state.textContent = entry.enabled ? '已启用 · 免提现手续费' : '未启用'; note.textContent = '配置版本 ' + entry.revision;
    button.textContent = '编辑'; button.className = 'secondary'; button.onclick = () => { edit(entry); $('editor').scrollIntoView({ behavior: 'smooth' }); };
    detail.append(wallet, state, note); row.append(detail, button); $('entries').append(row);
  }
}
async function load(after = '') {
  const data = await api(undefined, after); schema = data; cursor = data.nextCursor;
  entries(data.entries, !!after); $('more').hidden = !cursor; $('editor').hidden = false; $('entries-section').hidden = false;
  if (!after && !activeAddress) edit();
}
$('login').onsubmit = async event => {
  event.preventDefault(); if (busy) return; setBusy(true); adminKey = $('admin-key').value; $('admin-key').value = '';
  try { await load(); status('配置已读取。新增地址默认不启用。'); } catch (e) { status(e.message, true); } finally { setBusy(false); }
};
$('logout').onclick = () => { adminKey = ''; activeAddress = null; schema = null; $('admin-key').value = ''; $('entries').replaceChildren(); $('editor').hidden = true; $('entries-section').hidden = true; status('已退出管理'); };
$('new-entry').onclick = () => edit();
$('more').onclick = async () => { setBusy(true); try { await load(cursor); } catch (e) { status(e.message, true); } finally { setBusy(false); } };
$('policy-form').onsubmit = async event => {
  event.preventDefault(); if (busy) return;
  const values = weights(); if (values.some(w => !Number.isInteger(w) || w < 0 || w > 10000) || values.reduce((a, w) => a + w, 0) !== 10000) return status('各档概率必须合计100%，最多两位小数', true);
  setBusy(true);
  try { const saved = await api({ address: $('wallet').value.trim(), weights: values, enabled: $('enabled').checked, revision }); edit(saved); await load(); status(saved.enabled ? '已保存并启用，下次下注使用新概率；旧页面需刷新规则。' : '已保存为停用状态，使用普通概率。'); }
  catch (e) { status(e.message, true); } finally { setBusy(false); }
};
window.addEventListener('pagehide', () => { adminKey = ''; });
