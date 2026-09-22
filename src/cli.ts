#!/usr/bin/env node
import { resolve } from 'node:path';
import { runAudit } from './audit.js';
import { runSelftest } from './harness/selftest.js';
import { serve } from './ui/server.js';
import { KnowledgeStore } from './knowledge/store.js';
import { keySource, selectProvider } from './model/provider.js';
import { LEVEL_NAMES, Level } from './knowledge/types.js';
import { join } from 'node:path';

const pad = (s: string, n: number) => s.padEnd(n);

function usage(): void {
  process.stdout.write(`
SHEPARD

  shepard audit <path>        learn a repository, verify it, decide on acceptance
  shepard findings <path>     what is currently wrong, and what is known
  shepard status <path>       health, coverage, last audit
  shepard selftest <path>     plant known defects in a copy and measure what shepard catches
  shepard watch <path>        serve the screen
  shepard model               report whether model access is configured, and prove it

options
  --base-url <url>            verify an already-running instance instead of booting one
  --port <n>                  port to boot the application on (default 3000)
  --max-routes <n>            cap the crawl (default 40)
  --confirmations <n>         times a candidate must reproduce to be reported (default 2)
  --skip-install              do not run dependency installation

`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function cmdAudit(root: string): Promise<void> {
  const out = process.stdout;
  out.write(`\nSHEPARD\n\nonboarding: ${root}\n\n`);

  const result = await runAudit({
    root,
    baseUrl: arg('base-url'),
    port: arg('port') ? Number(arg('port')) : undefined,
    maxRoutes: arg('max-routes') ? Number(arg('max-routes')) : undefined,
    confirmations: arg('confirmations') ? Number(arg('confirmations')) : undefined,
    skipInstall: process.argv.includes('--skip-install'),
  });

  const { inventory: inv, comprehension: c, health, acceptance } = result;

  out.write(`what this is\n`);
  out.write(`  ${c.summary}\n`);
  if (!c.available) {
    out.write(`  no model available, so this is structure without understanding.\n`);
  }
  if (c.available && c.actors.length) {
    out.write(`\n  who uses it\n`);
    for (const a of c.actors) out.write(`    ${pad(a.name, 20)} ${a.evidence}\n`);
  }
  if (c.available && c.systems.length) {
    out.write(`\n  its systems\n`);
    for (const s of c.systems) out.write(`    [${pad(s.importance, 10)}] ${pad(s.name, 22)} ${s.evidence}\n`);
  }
  out.write(`\n`);

  out.write(`what was found\n`);
  out.write(`  frameworks: ${inv.frameworks.join(', ') || 'none detected'}\n`);
  const store = new KnowledgeStore(join(root, '.shepard', 'knowledge.db'));
  const counts = store.surfaceCounts(result.appId);
  for (const [kind, n] of Object.entries(counts)) {
    out.write(`  ${pad(kind + 's', 14)} ${n}\n`);
  }
  out.write(`\n`);

  out.write(`how far shepard could get\n`);
  out.write(`  level: ${result.level} (${LEVEL_NAMES[result.level as Level]})\n`);
  for (const u of result.unmet) {
    out.write(`  needs ${u.need}${u.detail ? ` — ${u.detail}` : ''} for level ${u.level}\n`);
  }
  out.write(`\n`);

  const open = store.findings(result.appId, { open: true });
  if (open.length) {
    out.write(`what is wrong\n`);
    for (const f of open.slice(0, 20)) {
      out.write(`  [${pad(f.severity, 8)}] ${f.title}\n`);
      out.write(`             expected: ${f.expected}\n`);
      out.write(`             observed: ${f.observed}\n`);
      out.write(`             impact:   ${f.impact}\n`);
      out.write(`             status:   ${f.status}\n\n`);
    }
  } else {
    out.write(`what is wrong\n  nothing detected on the surface shepard could reach.\n\n`);
  }

  out.write(`health\n`);
  out.write(`  state: ${health.state}\n`);
  out.write(`  coverage: ${Math.round(health.coverage * 100)}% (${health.verifiedSurfaces} of ${health.totalSurfaces} reachable surfaces)\n`);
  out.write(`  critical: ${health.criticalCount}\n`);
  out.write(`  need attention: ${health.needsAttentionCount}\n`);
  if (health.unverifiedReasons.length) {
    out.write(`  unverified:\n`);
    for (const r of health.unverifiedReasons) out.write(`    ${r}\n`);
  }
  out.write(`\n`);

  out.write(`acceptance\n`);
  for (const check of acceptance.checklist) {
    out.write(`  ${check.passed ? 'ok  ' : '>>> '} ${check.check}${check.detail ? ` — ${check.detail}` : ''}\n`);
  }
  out.write(`\n  ${acceptance.state.replace(/_/g, ' ')}.\n`);
  if (acceptance.reasons.length) {
    for (const r of acceptance.reasons) out.write(`  ${r}\n`);
  }
  out.write(`\n`);
  store.close();
}

function cmdFindings(root: string): void {
  const store = new KnowledgeStore(join(root, '.shepard', 'knowledge.db'));
  const app = store.findApplicationByRoot(resolve(root));
  if (!app) { process.stdout.write('\nno audit has been run for this repository.\n\n'); return; }
  const all = store.findings(app.id);
  process.stdout.write('\n');
  for (const f of all) {
    process.stdout.write(`[${pad(f.status, 11)}] [${pad(f.severity, 8)}] ${f.title}\n`);
  }
  process.stdout.write(`\n${all.length} finding(s).\n\n`);
  store.close();
}

function cmdStatus(root: string): void {
  const store = new KnowledgeStore(join(root, '.shepard', 'knowledge.db'));
  const app = store.findApplicationByRoot(resolve(root));
  if (!app) { process.stdout.write('\nno audit has been run for this repository.\n\n'); return; }
  const acq = store.latestAcquisition(app.id);
  const open = store.findings(app.id, { open: true });
  process.stdout.write(`\nSHEPARD\n\n`);
  process.stdout.write(`repository: ${app.name}\n`);
  process.stdout.write(`level: ${acq ? LEVEL_NAMES[acq.level as Level] : 'unknown'}\n`);
  process.stdout.write(`critical: ${open.filter(f => f.severity === 'critical').length}\n`);
  process.stdout.write(`need attention: ${open.filter(f => f.severity !== 'critical').length}\n\n`);
  store.close();
}

async function cmdSelftest(root: string): Promise<void> {
  const out = process.stdout;
  out.write(`\nSHEPARD SELFTEST\n\nplanting known defects in copies of: ${root}\n\n`);
  const results = await runSelftest(root, {
    port: arg('port') ? Number(arg('port')) : undefined,
    only: arg('only')?.split(','),
  });
  for (const r of results) {
    const mark = r.blocked ? 'BLOCKED' : r.caught ? 'caught ' : 'MISSED ';
    out.write(`${mark} ${pad(r.mutation, 22)} ${r.describe}\n`);
    if (r.matchedTitle) out.write(`         ${r.matchedTitle}\n`);
    if (r.blocked) out.write(`         not measured: ${r.blocked}\n`);
    else if (!r.caught) out.write(`         expected a ${r.expected} finding; got: ${r.alsoFound.join(' | ') || 'nothing'}\n`);
    out.write('\n');
  }
  const caught = results.filter(r => r.caught).length;
  const blocked = results.filter(r => r.blocked).length;
  const measured = results.length - blocked;

  // A blocked test is not a miss and it is certainly not a pass, so the score
  // is stated over what was actually measured and the gap is stated separately.
  out.write(`${caught} of ${measured} measured planted defects found.\n`);
  if (blocked) {
    out.write(`${blocked} of ${results.length} could not be measured at all — this run does not show whether shepard can see.\n`);
  }
  out.write('\n');
  if (caught < measured || blocked) process.exitCode = 1;
}

/**
 * Answer the one question a container cannot be interrogated about: does this
 * process have model access, and did the key actually work?
 *
 * It reports the *name* of the variable a key was found under and never any part
 * of the value, so it stays safe to run and to paste. Presence is not the claim
 * that matters, though: a key can be present and rejected. So it also spends one
 * minimal request, and reports what the API said, because "configured" and
 * "working" are different states and only the second one is worth having.
 */
async function cmdModel(): Promise<void> {
  const out = process.stdout;
  const source = keySource();
  out.write('\n');
  if (!source) {
    out.write('No API key reached this process.\n');
    out.write('Looked for SHEPARD_ANTHROPIC_API_KEY, then ANTHROPIC_API_KEY. Neither is set.\n');
    out.write('Shepard will audit structure and will not claim an understanding.\n\n');
    process.exitCode = 1;
    return;
  }
  out.write(`A key is present, from ${source}.\n`);
  const provider = await selectProvider();
  out.write(`Provider: ${provider.name}\n`);
  try {
    await provider.verify();
    out.write('The API accepted the key. Model access is working.\n\n');
  } catch (err) {
    const msg = (err as Error).message;
    // A 401 means the key arrived and was refused, which is a different problem
    // from a key that never arrived, and the difference is the whole diagnosis.
    out.write(`The API rejected the request: ${msg}\n`);
    out.write(/401|authentication|invalid x-api-key/i.test(msg)
      ? 'That is an authentication failure, so the variable is reaching Shepard but the key itself is wrong, revoked, or from another account.\n\n'
      : 'That is not an authentication failure, so the key is reaching Shepard and the fault is elsewhere.\n\n');
    process.exitCode = 1;
  }
}

const [, , cmd, target] = process.argv;
if (cmd === 'model') { await cmdModel(); process.exit(process.exitCode ?? 0); }
if (!cmd || !target) { usage(); process.exit(1); }
const root = resolve(target);

try {
  if (cmd === 'audit') await cmdAudit(root);
  else if (cmd === 'selftest') await cmdSelftest(root);
  else if (cmd === 'watch') serve(root, arg('port') ? Number(arg('port')) : 4100);
  else if (cmd === 'findings') cmdFindings(root);
  else if (cmd === 'status') cmdStatus(root);
  else { usage(); process.exit(1); }
} catch (err) {
  process.stderr.write(`\nshepard failed: ${(err as Error).message}\n\n`);
  process.exit(1);
}
