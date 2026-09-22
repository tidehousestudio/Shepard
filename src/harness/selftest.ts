import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAudit } from '../audit.js';
import { takeInventory } from '../discover/inventory.js';
import { deriveRecipe } from '../acquire/ladder.js';
import { Level } from '../knowledge/types.js';
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

/**
 * The next port nothing is listening on.
 *
 * Shepard now refuses to audit a port that was already answering, which is the
 * right behaviour and makes a collision surface as a blocked test rather than a
 * false verdict. The harness should not spend its runs on that, so it picks
 * ports that are actually free instead of assuming a fixed range is.
 */
async function freePortFrom(start: number): Promise<number> {
  for (let port = start; port < start + 200; port++) {
    const free = await new Promise<boolean>(resolve => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`no free port found from ${start}`);
}

export interface SelftestResult {
  mutation: string;
  describe: string;
  expected: string;
  caught: boolean;
  matchedTitle?: string;
  alsoFound: string[];
  /**
   * Set when Shepard never got far enough to have an opinion. A blocked test is
   * not a passed test and it is not a failed one either; it is the harness
   * admitting it measured nothing, which is the same distinction Shepard draws
   * between verified healthy and unverified.
   */
  blocked?: string;
}

/**
 * The harness is worthless if it cannot tell "Shepard looked and saw nothing"
 * from "Shepard never got to look".
 *
 * Every copy is audited with installation skipped, because installing five
 * times over is waste. That only holds if the fixture's dependencies are
 * already present, and when they are not every copy silently fails to boot and
 * every mutation reads as MISSED — a total detection failure reported in the
 * same words as a real one. So the precondition is established once, out loud,
 * before any defect is planted.
 */
function ensureFixtureRunnable(fixtureRoot: string): string | null {
  const inv = takeInventory(fixtureRoot);
  const recipe = deriveRecipe(inv);
  if (!recipe.install) return 'no recognised package manifest, so the fixture cannot be booted';
  if (existsSync(join(fixtureRoot, 'node_modules'))) return null;

  try {
    execFileSync(recipe.install[0]!, recipe.install.slice(1),
      { cwd: fixtureRoot, stdio: 'ignore', timeout: 300_000 });
  } catch {
    return `\`${recipe.install.join(' ')}\` failed in the fixture, so no copy of it can boot`;
  }
  return existsSync(join(fixtureRoot, 'node_modules'))
    ? null
    : 'dependency installation left no node_modules, so no copy of the fixture can boot';
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
  const blocker = ensureFixtureRunnable(fixtureRoot);
  if (blocker) {
    throw new Error(
      `the selftest fixture cannot run, so nothing would be measured: ${blocker}`);
  }

  const results: SelftestResult[] = [];
  const chosen = opts.only?.length
    ? MUTATIONS.filter(m => opts.only!.includes(m.name))
    : MUTATIONS;

  const port = opts.port ?? 3200;

  for (const mutation of chosen) {
    const work = mkdtempSync(join(tmpdir(), 'shepard-selftest-'));
    const root = join(work, 'app');
    cpSync(fixtureRoot, root, { recursive: true, filter: src => !src.includes('.shepard') });

    try {
      // Healthy baseline first. Shepard has to know what right looks like
      // before it can be asked whether something is wrong.
      const baseline = await runAudit({
        root, port: await freePortFrom(port), skipInstall: true, confirmations: 1, kind: 'onboarding',
      });

      // Below Boots there is no running application, so no control was pressed
      // and no request was made. Reporting that as a miss would blame detection
      // for a hole in the setup.
      if (baseline.level < Level.Boots) {
        results.push({
          mutation: mutation.name,
          describe: mutation.describe,
          expected: mutation.expect,
          caught: false,
          alsoFound: [],
          blocked: baseline.unmet.find(u => u.level === Level.Boots)?.need
            ?? `the healthy copy only reached level ${baseline.level}`,
        });
        continue;
      }

      mutation.apply(root);

      const after = await runAudit({
        root, port: await freePortFrom(port), skipInstall: true, confirmations: 2, kind: 'scheduled',
      });

      // The healthy copy booted and the mutated one did not. That is a real
      // regression, but it is not the one this mutation is measuring, so it
      // must not be counted as catching the planted defect.
      if (after.level < Level.Boots) {
        results.push({
          mutation: mutation.name,
          describe: mutation.describe,
          expected: mutation.expect,
          caught: false,
          alsoFound: [],
          blocked: 'the mutated copy stopped booting, so the planted defect was never exercised',
        });
        continue;
      }

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
