import type { KnowledgeStore } from '../knowledge/store.js';
import { Level, type FindingRow } from '../knowledge/types.js';

export type HealthState = 'healthy' | 'degraded' | 'critical' | 'blind';

export interface Health {
  state: HealthState;
  coverage: number;          // 0..1, mechanically computed, never asserted
  verifiedSurfaces: number;
  totalSurfaces: number;
  criticalCount: number;
  needsAttentionCount: number;
  unverifiedReasons: string[];
  level: Level;
}

/**
 * Coverage is computed from the enumerated surface, never claimed by a model.
 *
 * The agent running Shepard is overconfident about being done; asking it whether
 * it has tested enough would get a reassuring answer. So the denominator is
 * every surface that was mechanically enumerated, and the numerator is only
 * those that were actually exercised in this cycle.
 */
export function computeHealth(
  store: KnowledgeStore,
  appId: string,
  exercised: Set<string>,
  level: Level,
  unmet: { level: Level; need: string; detail?: string }[],
): Health {
  const surfaces = store.surfaces(appId);
  // Only surfaces reachable at the level Shepard actually attained can count
  // against it. A database table is not "uncovered" when Shepard never got a
  // database; it is unverified, and that is reported separately.
  const reachable = surfaces.filter(s =>
    level >= Level.Boots ? s.kind === 'route' || s.kind === 'control' : false);

  const verified = reachable.filter(s => exercised.has(`${s.kind}::${s.identifier}`)).length;
  const coverage = reachable.length === 0 ? 0 : verified / reachable.length;

  const open = store.findings(appId, { open: true });
  const criticalCount = open.filter(f => f.severity === 'critical').length;
  const needsAttentionCount = open.filter(f => f.severity !== 'critical' && f.severity !== 'info').length;

  const unverifiedReasons = unmet.map(u =>
    u.detail ? `${u.need} (${u.detail})` : u.need);

  let state: HealthState;
  if (level < Level.Boots || reachable.length === 0 || coverage === 0) {
    // Three-valued logic needs a three-valued picture. If Shepard could not see,
    // the sheep must not look safe.
    state = 'blind';
  } else if (criticalCount > 0) {
    state = 'critical';
  } else if (needsAttentionCount > 0 || coverage < 0.5) {
    state = 'degraded';
  } else {
    state = 'healthy';
  }

  return {
    state, coverage,
    verifiedSurfaces: verified,
    totalSurfaces: reachable.length,
    criticalCount, needsAttentionCount,
    unverifiedReasons, level,
  };
}

export interface AcceptanceDecision {
  accepted: boolean;
  state: 'accepted' | 'accepted_with_known_issues' | 'denied';
  reasons: string[];
  checklist: { check: string; passed: boolean; detail?: string }[];
}

/**
 * The acceptance gate.
 *
 * Deliberately not a purity test. Requiring the absence of every defect would
 * mean no real repository is ever accepted, Shepard denies everything, and it
 * never reaches the job it exists to do. The brief's actual intent — do not
 * learn broken behaviour as the healthy baseline — is satisfied by gating on
 * severity and coverage, and by recording non-critical issues into the baseline
 * as explicitly known rather than letting them pass as healthy.
 *
 * The gate is mechanical. The model may argue about severity; it does not get to
 * decide whether the gate opened.
 */
export function decideAcceptance(
  health: Health,
  findings: FindingRow[],
  opts: { minCoverage?: number; minLevel?: Level } = {},
): AcceptanceDecision {
  const minCoverage = opts.minCoverage ?? 0.6;
  const minLevel = opts.minLevel ?? Level.Boots;

  const criticals = findings.filter(f =>
    f.severity === 'critical' && ['new', 'known', 'recurrence'].includes(f.status));
  const knownIssues = findings.filter(f =>
    f.severity !== 'critical' && f.severity !== 'info' && ['new', 'known', 'recurrence'].includes(f.status));

  const checklist = [
    {
      check: `application reached at least the "boots" capability level`,
      passed: health.level >= minLevel,
      detail: health.level >= minLevel ? undefined : `reached level ${health.level}`,
    },
    {
      check: 'no critical finding is verified broken',
      passed: criticals.length === 0,
      detail: criticals.length ? `${criticals.length} critical: ${criticals.slice(0, 3).map(c => c.title).join('; ')}` : undefined,
    },
    {
      check: `coverage of the reachable surface is at or above ${Math.round(minCoverage * 100)}%`,
      passed: health.coverage >= minCoverage,
      detail: `${Math.round(health.coverage * 100)}% of ${health.totalSurfaces} surfaces`,
    },
    {
      check: 'Shepard was able to see the application at all',
      passed: health.state !== 'blind',
    },
  ];

  const failed = checklist.filter(c => !c.passed);
  if (failed.length) {
    return {
      accepted: false, state: 'denied',
      reasons: failed.map(f => f.detail ? `${f.check} — ${f.detail}` : f.check),
      checklist,
    };
  }

  return {
    accepted: true,
    state: knownIssues.length ? 'accepted_with_known_issues' : 'accepted',
    reasons: knownIssues.length
      ? [`${knownIssues.length} non-critical issue(s) recorded into the baseline as known`]
      : [],
    checklist,
  };
}
