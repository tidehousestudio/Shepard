import type { PageVisit, ControlProbe } from './browser.js';
import type { Severity, ExpectationSource } from '../knowledge/types.js';
import { fingerprint } from '../findings/fingerprint.js';

export interface Candidate {
  fingerprint: string;
  class: string;
  title: string;
  expected: string;
  observed: string;
  impact: string;
  severity: Severity;
  surfaceKind: string;
  surfaceIdentifier: string;
  /** Which expectation sources justify this. Never code_derived alone. */
  sources: ExpectationSource[];
  evidence: Record<string, unknown>;
}

/**
 * Noise that is not the application's fault. Browser extensions, analytics
 * blockers and favicon requests would otherwise produce a steady drip of
 * findings that trains the user to ignore Shepard, which is the one failure mode
 * a reliability system cannot recover from.
 */
const IGNORABLE_ERROR = /favicon|ERR_BLOCKED_BY_CLIENT|net::ERR_ABORTED|DevTools|sourcemap/i;

const isIgnorable = (e: string) => IGNORABLE_ERROR.test(e);

/**
 * Paths that conventionally sit behind authentication. A hint only: it decides
 * whether an anonymous 200 is suspicious, never whether a surface is healthy.
 * At capability level 4, discovered roles and policies replace this guess.
 */
const PROTECTED_HINT = /(^|\/)(admin|dashboard|settings|account|billing|internal|staff|manage)(\/|$)/i;

/**
 * Universal invariants: expectations that hold for any web application, whatever
 * its code says.
 *
 * This is the implementation-independent half of the oracle. None of these need
 * to know what the application is for, which is exactly why they survive a
 * defect planted in the source: the expectation was never read from the source
 * in the first place.
 */
export function invariantsForVisit(
  visit: PageVisit,
  ctx: {
    actor?: 'anonymous' | string;
    protectedRoutes?: ReadonlySet<string>;
    /** Routes that carried an authorization check at the last accepted baseline. */
    previouslyGuarded?: ReadonlySet<string>;
  } = {},
): Candidate[] {
  const out: Candidate[] = [];
  const at = visit.path;
  const anonymous = (ctx.actor ?? 'anonymous') === 'anonymous';
  const looksProtected = ctx.protectedRoutes?.has(at) ?? PROTECTED_HINT.test(at);

  if (visit.status === null) {
    out.push({
      fingerprint: fingerprint({ class: 'route_unreachable', surfaceKind: 'route', surfaceIdentifier: at }),
      class: 'route_unreachable',
      title: `Route ${at} could not be loaded`,
      expected: 'the route renders a page',
      observed: 'navigation failed or timed out',
      impact: 'the page is unreachable for every user',
      severity: 'critical',
      surfaceKind: 'route', surfaceIdentifier: at,
      sources: ['invariant', 'affordance'],
      evidence: { path: at },
    });
    return out;
  }

  // An unauthenticated request meeting a 401 or 403 is the authorization
  // boundary doing its job. Reporting it as a defect is how a reliability system
  // teaches its user to ignore it. This is the positive result of a negative
  // case, not a failure — and at higher capability levels, with real identities,
  // the same response for a role that *should* have access is a genuine finding.
  const authBoundary = anonymous && (visit.status === 401 || visit.status === 403);

  // The inverse is the one that matters: a surface that looks protected and
  // answers an anonymous caller anyway. Proving an administrator can reach
  // something never proved that a stranger cannot.
  if (anonymous && looksProtected && visit.status >= 200 && visit.status < 300) {
    // Severity turns on the strength of the evidence, not on how alarming the
    // words are. A guard found in the code is cross-layer evidence that this
    // route is meant to be protected, and an anonymous 200 then contradicts it.
    // A path that merely *reads* as private is a hint, and a hint that shouts
    // "critical" is how a reliability system trains its user to ignore it.
    // Three strengths of evidence, and the middle one is the interesting case.
    //
    // A guard visible in today's code is cross-layer evidence. A guard that was
    // there at the last baseline and is gone now is *historical* evidence, and
    // it is the only thing that catches a defect which deleted its own
    // expectation: read today's code alone and the missing check looks like a
    // route that was never meant to be protected. A suggestive path name is
    // neither, and gets reported as the hint it is.
    const guardedNow = ctx.protectedRoutes?.has(at) ?? false;
    const guardedBefore = ctx.previouslyGuarded?.has(at) ?? false;
    const regression = guardedBefore && !guardedNow;
    const evidenced = guardedNow || regression;
    out.push({
      fingerprint: fingerprint({
        class: evidenced ? 'auth_leak' : 'possible_auth_leak',
        surfaceKind: 'route', surfaceIdentifier: at,
      }),
      class: evidenced ? 'auth_leak' : 'possible_auth_leak',
      title: regression
        ? `Route ${at} no longer refuses anonymous callers`
        : evidenced
        ? `Route ${at} has an authorization check but serves anonymous callers`
        : `Route ${at} reads as private but is served to anonymous callers`,
      expected: regression
        ? 'this route required authorization at the accepted baseline'
        : evidenced
        ? 'a route with an authorization check refuses an unauthenticated caller'
        : 'a route under a conventionally private path requires authentication',
      observed: `HTTP ${visit.status} for an anonymous request`,
      impact: evidenced
        ? 'anyone can reach a surface that is meant to be protected'
        : 'this may be intentional; Shepard cannot yet tell without a role to test with',
      severity: evidenced ? 'critical' : 'low',
      surfaceKind: 'route', surfaceIdentifier: at,
      sources: regression ? ['history', 'invariant']
             : evidenced ? ['cross_layer', 'invariant'] : ['invariant'],
      evidence: { status: visit.status, guardedNow, guardedBefore },
    });
  }

  if (visit.status >= 400 && !authBoundary) {
    out.push({
      fingerprint: fingerprint({ class: 'http_error', surfaceKind: 'route', surfaceIdentifier: at }),
      class: 'http_error',
      title: `Route ${at} returns HTTP ${visit.status}`,
      expected: 'a discovered route responds successfully',
      observed: `HTTP ${visit.status}`,
      impact: visit.status >= 500 ? 'the page is broken for every user' : 'the page is missing or forbidden',
      severity: visit.status >= 500 ? 'critical' : 'high',
      surfaceKind: 'route', surfaceIdentifier: at,
      sources: ['invariant'],
      evidence: { status: visit.status },
    });
  }

  // The browser also reports a refused load as a console error, so the same
  // reasoning has to reach this channel too. Suppressing it in one place and not
  // another is how a "fixed" false positive comes back wearing a different hat.
  const authNoise = (e: string) =>
    anonymous && /failed to load resource/i.test(e) && /\b(401|403)\b/.test(e);

  for (const err of visit.consoleErrors.filter(e => !isIgnorable(e) && !authNoise(e))) {
    out.push({
      fingerprint: fingerprint({
        class: 'console_error', surfaceKind: 'route', surfaceIdentifier: at, discriminator: err,
      }),
      class: 'console_error',
      title: `Console error on ${at}`,
      expected: 'a page loads without unhandled errors',
      observed: err.slice(0, 300),
      impact: 'behaviour on this page may be silently degraded',
      severity: 'medium',
      surfaceKind: 'route', surfaceIdentifier: at,
      sources: ['invariant'],
      evidence: { error: err },
    });
  }

  for (const req of visit.failedRequests.filter(e => !isIgnorable(e))) {
    const m = /^HTTP (\d+) (.+)$/.exec(req);
    const code = m ? Number(m[1]) : 0;
    // Same reasoning as above: a refused anonymous request is the boundary working.
    if (anonymous && (code === 401 || code === 403)) continue;
    out.push({
      fingerprint: fingerprint({
        class: 'failed_request', surfaceKind: 'route', surfaceIdentifier: at, discriminator: m?.[2] ?? req,
      }),
      class: 'failed_request',
      title: `Request from ${at} failed with ${code || 'an error'}`,
      expected: 'requests a page makes on load succeed',
      observed: req.slice(0, 300),
      impact: code >= 500 ? 'a backend call this page depends on is failing'
                          : 'this page depends on something that is missing',
      severity: code >= 500 ? 'high' : 'medium',
      surfaceKind: 'route', surfaceIdentifier: at,
      sources: ['invariant', 'cross_layer'],
      evidence: { request: req },
    });
  }

  for (const c of visit.controls) out.push(...invariantsForControl(at, c, { anonymous }));
  return out;
}

/**
 * The dead-control detector.
 *
 * A control that exists is a promise that pressing it does something. That
 * promise comes from the affordance, not from the code behind it, which is why
 * this catches a defect planted by deleting a handler: the source and the
 * running application agree perfectly, and they are both wrong.
 */
export function invariantsForControl(
  path: string,
  c: ControlProbe,
  ctx: { anonymous?: boolean } = {},
): Candidate[] {
  const out: Candidate[] = [];
  const identity = `${path}#${c.label || c.selector}`;

  const anonymous = ctx.anonymous ?? true;
  const realErrors = c.errors
    .filter(e => !isIgnorable(e))
    .filter(e => !(anonymous && /HTTP 40[13]\b/.test(e)));
  if (realErrors.length) {
    const first = realErrors[0]!;
    const code = /HTTP (\d+)/.exec(first)?.[1];
    out.push({
      fingerprint: fingerprint({
        class: code ? 'broken_control_request' : 'control_error',
        surfaceKind: 'control', surfaceIdentifier: identity, discriminator: code ?? first,
      }),
      class: code ? 'broken_control_request' : 'control_error',
      title: code
        ? `"${c.label || c.selector}" on ${path} leads to HTTP ${code}`
        : `"${c.label || c.selector}" on ${path} raises an error`,
      expected: `activating "${c.label || c.selector}" completes without error`,
      observed: first.slice(0, 300),
      impact: 'the user is taken to a broken destination or the action fails',
      severity: code && Number(code) >= 500 ? 'critical' : 'high',
      surfaceKind: 'control', surfaceIdentifier: identity,
      sources: ['affordance', 'invariant'],
      evidence: { effects: c.effects, errors: realErrors },
    });
    return out;
  }

  if (c.effects.length === 0) {
    out.push({
      fingerprint: fingerprint({
        class: 'inert_control', surfaceKind: 'control', surfaceIdentifier: identity,
      }),
      class: 'inert_control',
      title: `"${c.label || c.selector}" on ${path} does nothing`,
      expected: 'activating a control produces some observable effect',
      observed: 'no DOM change, no navigation, no storage write and no network request',
      impact: 'the user presses it and nothing happens, with no error to explain why',
      severity: 'high',
      surfaceKind: 'control', surfaceIdentifier: identity,
      sources: ['affordance'],
      evidence: { selector: c.selector, label: c.label },
    });
  }

  return out;
}

/**
 * Severity is weighted by the journey a surface belongs to, not by the kind of
 * error. A console warning on a marketing page and a failing checkout are not
 * the same event, and grading them identically produces a "needs attention"
 * count that nobody reads.
 */
export function weightSeverity(base: Severity, importance: 'core' | 'supporting' | 'peripheral'): Severity {
  const order: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];
  const i = order.indexOf(base);
  const shift = importance === 'core' ? 1 : importance === 'peripheral' ? -1 : 0;
  return order[Math.min(order.length - 1, Math.max(0, i + shift))]!;
}
