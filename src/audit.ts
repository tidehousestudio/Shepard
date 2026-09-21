import { join } from 'node:path';
import { KnowledgeStore } from './knowledge/store.js';
import { EvidenceStore } from './evidence/store.js';
import { Level, type Severity } from './knowledge/types.js';
import { takeInventory, type Inventory } from './discover/inventory.js';
import { enumerateStatic } from './discover/enumerate/static.js';
import { acquire, type Unmet } from './acquire/ladder.js';
import { BrowserSession } from './execute/browser.js';
import { invariantsForVisit, weightSeverity, type Candidate } from './execute/invariants.js';
import { computeHealth, decideAcceptance, type Health, type AcceptanceDecision } from './health/compute.js';
import { selectProvider } from './model/provider.js';
import type { Comprehension } from './model/provider.js';

export interface AuditOptions {
  root: string;
  baseUrl?: string;
  port?: number;
  kind?: 'onboarding' | 'scheduled' | 'requalify';
  maxRoutes?: number;
  /** How many times a candidate must reproduce before it becomes a finding. */
  confirmations?: number;
  skipInstall?: boolean;
}

export interface AuditResult {
  appId: string;
  inventory: Inventory;
  comprehension: Comprehension;
  level: Level;
  unmet: Unmet[];
  health: Health;
  acceptance: AcceptanceDecision;
  findingsSummary: { new: number; known: number; recurrence: number; resolved: number };
}

/**
 * One audit cycle.
 *
 * Wake, work out what needs verification, exercise it, adjudicate, update
 * knowledge, decide. The same path serves onboarding and every scheduled audit
 * afterwards; the difference is what has been learned already, not what the
 * cycle does.
 */
export async function runAudit(opts: AuditOptions): Promise<AuditResult> {
  const shepardDir = join(opts.root, '.shepard');
  const store = new KnowledgeStore(join(shepardDir, 'knowledge.db'));
  const evidence = new EvidenceStore(join(shepardDir, 'evidence'), store);
  const provider = selectProvider();

  // ---- inventory and enumeration -----------------------------------------
  const inv = takeInventory(opts.root);
  const existing = store.findApplicationByRoot(opts.root);
  const appId = existing?.id ?? store.createApplication({
    name: inv.root.split('/').filter(Boolean).pop() ?? 'application',
    rootPath: opts.root,
    headCommit: inv.headCommit ?? undefined,
  });
  if (inv.headCommit) {
    // Knowledge derived before this commit is suspect, not authoritative.
    if (existing?.head_commit && existing.head_commit !== inv.headCommit) {
      store.markStaleBefore(appId, inv.headCommit);
    }
    store.setHeadCommit(appId, inv.headCommit);
  }

  const cycleId = store.startCycle(appId, opts.kind ?? 'onboarding', inv.headCommit ?? undefined);

  // Read what Shepard believed before this enumeration overwrites it.
  const prior = store.priorAttributes(appId);

  const discovered = enumerateStatic(inv);
  for (const s of discovered) {
    const provId = store.recordProvenance(appId, {
      kind: 'parse', tool: s.via, detail: s.location, atCommit: inv.headCommit ?? undefined,
    });
    store.upsertSurface(appId, {
      kind: s.kind, identifier: s.identifier, label: s.label, location: s.location,
      safety: s.safety, provenanceId: provId, atCommit: inv.headCommit ?? undefined,
      attributes: { guarded: Boolean(s.guarded) },
    });
  }

  const comprehension = await provider.comprehend(inv, discovered);

  // ---- acquisition --------------------------------------------------------
  const acquisition = await acquire(inv, {
    baseUrl: opts.baseUrl, port: opts.port, skipInstall: opts.skipInstall,
  });
  store.recordAcquisition(appId, {
    level: acquisition.level, recipe: acquisition.recipe,
    unmet: acquisition.unmet, baseUrl: acquisition.baseUrl ?? undefined,
    atCommit: inv.headCommit ?? undefined,
  });

  const exercised = new Set<string>();
  const seenFingerprints: string[] = [];

  try {
    if (acquisition.level >= Level.Boots && acquisition.baseUrl) {
      const browser = new BrowserSession();
      await browser.open();
      try {
        // Which routes to visit: everything statically discovered, plus
        // anything the crawl finds that static analysis missed. The two
        // disagreeing is worth knowing about on its own.
        const staticRoutes = discovered
          .filter(s => s.kind === 'route' && !s.identifier.includes(':') && !s.identifier.includes('['))
          .map(s => s.identifier);
        const queue = [...new Set(['/', ...staticRoutes])].slice(0, opts.maxRoutes ?? 40);
        const visited = new Set<string>();
        const candidates: Candidate[] = [];
        const protectedRoutes = new Set(
          discovered.filter(s => s.kind === 'route' && s.guarded).map(s => s.identifier),
        );
        const previouslyGuarded = new Set(
          [...prior.entries()]
            .filter(([k, v]) => k.startsWith('route::') && v.guarded === true)
            .map(([k]) => k.slice('route::'.length)),
        );

        while (queue.length) {
          const path = queue.shift()!;
          if (visited.has(path)) continue;
          visited.add(path);

          const visit = await browser.visit(acquisition.baseUrl, path);
          // Anonymous is the only identity Shepard has below capability level 4,
          // and saying so is what keeps a refused request from reading as a defect.
          exercised.add(`route::${path}`);
          for (const c of visit.controls) {
            exercised.add(`control::${path}#${c.label || c.selector}`);
          }

          evidence.put(appId, 'json', JSON.stringify(visit, null, 2), { path });
          const runId = store.recordRun(appId, {
            cycleId, outcome: visit.status && visit.status < 400 ? 'pass' : 'fail',
            reason: `visited ${path}`,
            observations: [
              { key: 'status', value: String(visit.status) },
              { key: 'controls', value: String(visit.controls.length) },
              { key: 'consoleErrors', value: String(visit.consoleErrors.length) },
            ],
          });

          for (const cand of invariantsForVisit(visit, { actor: 'anonymous', protectedRoutes, previouslyGuarded })) {
            candidates.push({ ...cand, evidence: { ...cand.evidence, runId } });
          }

          // Links found by crawling that static analysis did not predict.
          for (const href of visit.links) {
            try {
              const p = new URL(href).pathname;
              if (!visited.has(p) && queue.length < (opts.maxRoutes ?? 40)) queue.push(p);
            } catch { /* not a usable link */ }
          }
        }

        // ---- confirmation ------------------------------------------------
        // A candidate must reproduce before it becomes a finding. A reliability
        // system that reports the first flake it sees gets ignored, and an
        // ignored Shepard is a failed Shepard.
        const required = opts.confirmations ?? 2;
        const confirmed = await confirmCandidates(browser, acquisition.baseUrl, candidates, required, protectedRoutes, previouslyGuarded);

        for (const c of confirmed) {
          const surface = store.surfaces(appId).find(s =>
            s.kind === c.surfaceKind && s.identifier === c.surfaceIdentifier);
          const severity: Severity = weightSeverity(c.severity, (surface?.importance ?? 'supporting') as any);
          seenFingerprints.push(c.fingerprint);
          store.observeFinding(appId, {
            fingerprint: c.fingerprint, surfaceId: surface?.id, class: c.class, title: c.title,
            expected: c.expected, observed: c.observed, impact: c.impact, severity,
          });
        }

        // Controls discovered at runtime are surfaces too, and they are the ones
        // static analysis is worst at: a button rendered by a component three
        // files away is invisible to a route parser.
        for (const key of exercised) {
          const [kind, ...rest] = key.split('::');
          if (kind !== 'control') continue;
          const provId = store.recordProvenance(appId, {
            kind: 'browser', tool: 'control-probe', detail: rest.join('::'),
            atCommit: inv.headCommit ?? undefined,
          });
          store.upsertSurface(appId, {
            kind: 'control', identifier: rest.join('::'), provenanceId: provId,
            safety: 'safe', atCommit: inv.headCommit ?? undefined,
          });
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await acquisition.stop();
  }

  const resolved = store.resolveUnseen(appId, seenFingerprints);
  const health = computeHealth(store, appId, exercised, acquisition.level, acquisition.unmet);
  const openFindings = store.findings(appId, { open: true });
  const acceptance = decideAcceptance(health, openFindings);

  store.recordBaseline(appId, {
    atCommit: inv.headCommit ?? 'unknown',
    state: acceptance.state,
    manifest: {
      surfaces: store.surfaceCounts(appId),
      exercised: [...exercised],
      coverage: health.coverage,
      level: acquisition.level,
      knownUnverified: health.unverifiedReasons,
      checklist: acceptance.checklist,
    },
    reason: acceptance.reasons.join('; ') || undefined,
  });

  store.endCycle(cycleId, acquisition.level, {
    coverage: health.coverage, state: health.state, accepted: acceptance.accepted,
  });

  const all = store.findings(appId);
  const result: AuditResult = {
    appId, inventory: inv, comprehension,
    level: acquisition.level, unmet: acquisition.unmet,
    health, acceptance,
    findingsSummary: {
      new: all.filter(f => f.status === 'new').length,
      known: all.filter(f => f.status === 'known').length,
      recurrence: all.filter(f => f.status === 'recurrence').length,
      resolved,
    },
  };

  store.close();
  return result;
}

/**
 * Re-execute each candidate independently. Only what reproduces is reported.
 *
 * A check that cannot make up its mind is a hole in Shepard's vision rather than
 * a fact about the application, so an unstable candidate is dropped here and
 * shows up as reduced coverage instead of as a finding.
 */
async function confirmCandidates(
  browser: BrowserSession,
  baseUrl: string,
  candidates: Candidate[],
  required: number,
  protectedRoutes: ReadonlySet<string>,
  previouslyGuarded: ReadonlySet<string>,
): Promise<Candidate[]> {
  if (required <= 1) return candidates;

  const byRoute = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const route = c.surfaceKind === 'route' ? c.surfaceIdentifier : c.surfaceIdentifier.split('#')[0]!;
    const list = byRoute.get(route) ?? [];
    list.push(c);
    byRoute.set(route, list);
  }

  const confirmed: Candidate[] = [];
  for (const [route, list] of byRoute) {
    const seen = new Map<string, number>(list.map(c => [c.fingerprint, 1]));
    for (let attempt = 1; attempt < required; attempt++) {
      const visit = await browser.visit(baseUrl, route);
      const again = new Set(invariantsForVisit(visit, { actor: 'anonymous', protectedRoutes, previouslyGuarded }).map(c => c.fingerprint));
      for (const [fp, n] of seen) if (again.has(fp)) seen.set(fp, n + 1);
    }
    for (const c of list) if ((seen.get(c.fingerprint) ?? 0) >= required) confirmed.push(c);
  }
  return confirmed;
}
