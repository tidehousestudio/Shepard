import { chromium, type Browser, type Page } from 'playwright';

export interface ControlProbe {
  selector: string;
  tag: string;
  label: string;
  href: string | null;
  effects: string[];          // dom | navigation | storage | network:N
  errors: string[];           // console errors and 4xx/5xx responses
  screenshot?: Buffer;
}

export interface PageVisit {
  path: string;
  status: number | null;
  title: string;
  consoleErrors: string[];
  failedRequests: string[];
  links: string[];            // same-origin hrefs found on the page
  controls: ControlProbe[];
}

interface Snapshot { dom: string; url: string; store: string }

const SNAPSHOT = () => ({
  dom: String(document.body?.innerHTML.length ?? 0) + ':' + (document.body?.innerText ?? ''),
  url: location.href,
  store: (() => {
    try { return JSON.stringify(localStorage) + JSON.stringify(sessionStorage); }
    catch { return ''; }
  })(),
});

/**
 * Drives a running application the way a user does, and records what happened
 * rather than what the code said would happen.
 *
 * Everything here is deterministic and replayable. No model is involved in the
 * execution path, which is what makes a re-run comparable to the run before it
 * and what stops a reliability system from flapping.
 */
export class BrowserSession {
  private browser!: Browser;

  async open(): Promise<void> {
    this.browser = await chromium.launch({ args: ['--no-sandbox'] });
  }

  async close(): Promise<void> {
    if (this.browser) await this.browser.close();
  }

  /**
   * Probe one control for *any* observable effect.
   *
   * The deliberate part is that this knows nothing about what the control is
   * supposed to do. An expectation read from the code that implements a button
   * inherits that code's defects: delete the handler and the code-derived
   * expectation becomes "does nothing", which the broken button satisfies. The
   * affordance is the independent source — a control that exists is a promise
   * that pressing it does something, and an empty effect set breaks that promise
   * no matter what the source says.
   */
  private async probeControl(page: Page, selector: string, meta: { tag: string; label: string; href: string | null }): Promise<ControlProbe> {
    const before = await page.evaluate(SNAPSHOT) as Snapshot;
    const network: string[] = [];
    const errors: string[] = [];

    const onRequest = (r: any) => network.push(`${r.method()} ${r.url()}`);
    const onConsole = (m: any) => { if (m.type() === 'error') errors.push(m.text()); };
    const onResponse = (r: any) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); };
    page.on('request', onRequest);
    page.on('console', onConsole);
    page.on('response', onResponse);

    try {
      await page.click(selector, { timeout: 2500, noWaitAfter: true });
    } catch {
      // A control that cannot be clicked is itself an observation, not an error
      // in Shepard. It falls out below as an empty effect set.
    }
    await page.waitForTimeout(700);

    page.off('request', onRequest);
    page.off('console', onConsole);
    page.off('response', onResponse);

    const after = await page.evaluate(SNAPSHOT) as Snapshot;
    const effects: string[] = [];
    if (before.dom !== after.dom) effects.push('dom');
    if (before.url !== after.url) effects.push('navigation');
    if (before.store !== after.store) effects.push('storage');
    if (network.length) effects.push(`network:${network.length}`);

    return { selector, ...meta, effects, errors };
  }

  /**
   * Visit one page, record what the browser saw, and exercise every control on
   * it. Controls are re-probed from a freshly loaded page each time so that one
   * control's effects cannot mask or manufacture another's.
   */
  async visit(baseUrl: string, path: string, opts: { probeControls?: boolean } = {}): Promise<PageVisit> {
    const page = await this.browser.newPage();
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('response', r => { if (r.status() >= 400) failedRequests.push(`HTTP ${r.status()} ${r.url()}`); });

    let status: number | null = null;
    try {
      const res = await page.goto(baseUrl + path, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      status = res?.status() ?? null;
      await page.waitForTimeout(400);
    } catch {
      await page.close();
      return { path, status: null, title: '', consoleErrors, failedRequests, links: [], controls: [] };
    }

    const title = await page.title().catch(() => '');
    const origin = new URL(baseUrl).origin;
    const links = await page.$$eval('a[href]', (els, o) => els
      .map(e => (e as HTMLAnchorElement).href)
      .filter(h => h.startsWith(o as string)), origin).catch(() => [] as string[]);

    const controls: ControlProbe[] = [];
    if (opts.probeControls !== false) {
      const found = await page.$$eval(
        'button, a[href], [role=button], input[type=submit], input[type=button]',
        els => els.map((e, i) => ({
          index: i,
          tag: e.tagName.toLowerCase(),
          label: ((e as HTMLElement).innerText || (e as HTMLInputElement).value || e.getAttribute('aria-label') || '').trim().slice(0, 60),
          href: e.getAttribute('href'),
          id: e.id || null,
        })),
      ).catch(() => [] as any[]);

      await page.close();

      for (const c of found) {
        // A stable selector matters more than a short one: findings are
        // fingerprinted on it, and a fingerprint that moves with the DOM would
        // turn every re-render into a new finding.
        const sameTag = found.filter((f: any) => f.tag === c.tag);
        const selector = c.id
          ? `[id="${c.id}"]`
          : `${c.tag}:nth-of-type(${sameTag.indexOf(c) + 1})`;
        const fresh = await this.browser.newPage();
        try {
          await fresh.goto(baseUrl + path, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          await fresh.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} });
          controls.push(await this.probeControl(fresh, selector, { tag: c.tag, label: c.label, href: c.href }));
        } catch {
          controls.push({ selector, tag: c.tag, label: c.label, href: c.href, effects: [], errors: ['control could not be reached'] });
        } finally {
          await fresh.close();
        }
      }
      return { path, status, title, consoleErrors, failedRequests, links, controls };
    }

    await page.close();
    return { path, status, title, consoleErrors, failedRequests, links, controls };
  }

  /** Follow a link without a browser, to classify it cheaply. */
  static async checkLink(url: string): Promise<number | null> {
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
      return res.status;
    } catch { return null; }
  }
}
