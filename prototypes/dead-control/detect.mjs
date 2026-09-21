import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const BASE = process.env.BASE || 'http://127.0.0.1:8933';

// Generic effect probe. Knows nothing about what any control is supposed to do.
async function probe(page, sel) {
  const before = await page.evaluate(() => ({
    dom: document.body.innerHTML.length + ':' + document.body.innerText,
    url: location.href,
    store: JSON.stringify(localStorage) + JSON.stringify(sessionStorage),
  }));
  const net = [], errs = [];
  const onReq = r => net.push(r.method() + ' ' + r.url());
  const onErr = m => m.type() === 'error' && errs.push(m.text());
  const onFail = r => r.status() >= 400 && errs.push('HTTP ' + r.status() + ' ' + r.url());
  page.on('request', onReq); page.on('console', onErr); page.on('response', onFail);
  try { await page.click(sel, { timeout: 2000 }); } catch { /* unclickable is its own signal */ }
  await page.waitForTimeout(600);
  page.off('request', onReq); page.off('console', onErr); page.off('response', onFail);
  const after = await page.evaluate(() => ({
    dom: document.body.innerHTML.length + ':' + document.body.innerText,
    url: location.href,
    store: JSON.stringify(localStorage) + JSON.stringify(sessionStorage),
  }));
  const effects = [];
  if (before.dom !== after.dom) effects.push('dom');
  if (before.url !== after.url) effects.push('navigation');
  if (before.store !== after.store) effects.push('storage');
  if (net.length) effects.push('network:' + net.length);
  return { effects, errors: errs };
}

const b = await chromium.launch();
const page = await b.newPage();
const rows = [];
// Enumerate mechanically — no model involved in finding the controls.
await page.goto(BASE + '/app.html');
const sels = await page.$$eval('button,a,[role=button],input[type=submit]',
  els => els.map(e => ({ tag: e.tagName.toLowerCase(), id: e.id, label: (e.innerText||e.value||'').trim() })));
for (const s of sels) {
  await page.goto(BASE + '/app.html');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  const r = await probe(page, '#' + s.id);
  rows.push({
    control: `${s.tag}#${s.id} "${s.label}"`,
    verdict: r.errors.length ? 'ERRORED' : r.effects.length ? 'effective' : 'INERT',
    effects: r.effects, errors: r.errors,
  });
}
await b.close();
for (const r of rows) console.log(
  (r.verdict === 'effective' ? '  ok   ' : '  >>>  ') +
  r.verdict.padEnd(10) + r.control.padEnd(42) +
  (r.effects.join(',') || '(no observable effect)') + (r.errors.length ? '  ! ' + r.errors[0] : ''));
