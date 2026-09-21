import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAudit } from '../audit.js';
import { KnowledgeStore } from '../knowledge/store.js';

export interface Mutation {
  name: string;
  /** The defect class Shepard must report for this test to count as passed. */
  expect: string;
  /** A fragment of the finding title that identifies the right target. */
  target?: string;
  describe: string;
  apply: (root: string) => void;
}

const edit = (root: string, rel: string, fn: (src: string) => string): void => {
  const p = join(root, rel);
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
};

/**
 * Defects drawn from how software actually breaks.
 *
 * The point of this catalogue is not to prove Shepard can find these particular
 * bugs. It is to measure Shepard's sensitivity *per class*, so that when it
 * misses one the fix goes into the general methodology responsible for that
 * class rather than into a special case for this mutation. A harness that
 * teaches Shepard these seven strings would be worse than no harness.
 */
export const MUTATIONS: Mutation[] = [
  {
    name: 'inert-control',
    expect: 'inert_control',
    target: 'Add House Blend',
    describe: 'remove a button\'s click handler, leaving the button in place',
    apply: root => edit(root, 'public/products.html', s =>
      s.replace('<button id="add-1" onclick="addToCart(1)">', '<button id="add-1">')),
  },
  {
    name: 'broken-link',
    expect: 'broken_control_request',
    target: 'Account',
    describe: 'point a navigation link at a page that does not exist',
    apply: root => edit(root, 'public/index.html', s =>
      s.replace('href="/account"', 'href="/acount"')),
  },
  {
    name: 'broken-api',
    expect: 'broken_control_request',
    target: 'Load products',
    describe: 'make an API the page depends on return a server error',
    apply: root => edit(root, 'server.js', s =>
      s.replace(
        "app.get('/api/products', (req, res) => res.json(products));",
        "app.get('/api/products', (req, res) => res.status(500).json({ error: 'boom' }));")),
  },
  {
    name: 'removed-auth-check',
    expect: 'auth_leak',
    target: '/admin/orders',
    describe: 'delete an authorization check, so the code no longer says the route is protected',
    apply: root => edit(root, 'server.js', s =>
      s.replace("  if (req.headers['x-role'] !== 'admin') return res.status(403).json({ error: 'forbidden' });\n", '')),
  },
  {
    name: 'silent-write-failure',
    expect: 'broken_control_request',
    target: 'Add Sourdough',
    describe: 'make a write endpoint reject the payload the UI actually sends',
    apply: root => edit(root, 'server.js', s =>
      s.replace('const id = req.body && req.body.productId;', 'const id = req.body && req.body.product_id;')),
  },
];

export interface SelftestResult {
  mutation: string;
  describe: string;
  expected: string;
  caught: boolean;
  matchedTitle?: string;
  alsoFound: string[];
}

/**
 * Plant a defect, audit, and check whether Shepard noticed.
 *
 * Each mutation runs against a fresh copy with a fresh baseline, because some
 * defects are only detectable as a change from what was there before. Running
 * them in one long sequence would let an earlier mutation's knowledge answer a
 * later mutation's question.
 */
export async function runSelftest(
  fixtureRoot: string,
  opts: { port?: number; only?: string[] } = {},
): Promise<SelftestResult[]> {
  const results: SelftestResult[] = [];
  const chosen = opts.only?.length
    ? MUTATIONS.filter(m => opts.only!.includes(m.name))
    : MUTATIONS;

  let port = opts.port ?? 3200;

  for (const mutation of chosen) {
    const work = mkdtempSync(join(tmpdir(), 'shepard-selftest-'));
    const root = join(work, 'app');
    cpSync(fixtureRoot, root, { recursive: true, filter: src => !src.includes('.shepard') });

    try {
      // Healthy baseline first. Shepard has to know what right looks like
      // before it can be asked whether something is wrong.
      await runAudit({ root, port: port++, skipInstall: true, confirmations: 1, kind: 'onboarding' });

      mutation.apply(root);

      const after = await runAudit({ root, port: port++, skipInstall: true, confirmations: 2, kind: 'scheduled' });

      const store = new KnowledgeStore(join(root, '.shepard', 'knowledge.db'));
      const open = store.findings(after.appId, { open: true });
      store.close();

      const hit = open.find(f =>
        f.class === mutation.expect &&
        (!mutation.target || f.title.toLowerCase().includes(mutation.target.toLowerCase())));

      results.push({
        mutation: mutation.name,
        describe: mutation.describe,
        expected: mutation.expect,
        caught: Boolean(hit),
        matchedTitle: hit?.title,
        alsoFound: open.filter(f => f !== hit).map(f => `${f.severity}: ${f.title}`),
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  return results;
}
