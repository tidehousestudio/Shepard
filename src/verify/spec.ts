import type { ExpectationSource } from '../knowledge/types.js';

/**
 * The grammar a generated verification case is allowed to be written in.
 *
 * This is deliberately small and deliberately closed. The alternative — letting
 * the model write an expectation in prose and then asking a model at run time
 * whether the application satisfied it — puts the model inside the execution
 * path, and re-runs stop being comparable. A reliability system that flaps is
 * one the user learns to ignore.
 *
 * So the division of labour is the same one the rest of Shepard uses. The model
 * chooses *which* steps and *which* assertions, from these fixed shapes, for one
 * mechanically enumerated part of the application. Code executes them and code
 * decides whether they held. No model is consulted about the result.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type Step =
  /** Load a page. */
  | { do: 'visit'; path: string }
  /**
   * Press a control identified by the label a user reads on it.
   *
   * Deliberately by label rather than by selector: the label is what the
   * application promises, and it is what an expectation about the control can
   * legitimately rest on. A selector is an implementation detail, and an
   * expectation resting on one is an expectation resting on the code.
   */
  | { do: 'click'; label: string }
  /** Call an enumerated endpoint directly. */
  | { do: 'request'; method: HttpMethod; path: string; body?: unknown };

/**
 * A read of application state, taken before the steps and again afterwards.
 *
 * This is what makes an app-specific expectation checkable without reading the
 * implementation: "pressing Add to cart makes the cart bigger" is decidable from
 * two reads of whatever the application itself exposes as the cart.
 */
export interface Probe {
  /** Name used by assertions to refer to this reading. */
  name: string;
  path: string;
  /** Dot path into the JSON body. `length` is allowed as a final segment. */
  extract: string;
}

export type Assertion =
  | { assert: 'status'; probe?: string; equals?: number; below?: number }
  | { assert: 'value_changed'; probe: string; by?: number; direction?: 'increase' | 'decrease' | 'any' }
  | { assert: 'value_equals'; probe: string; equals: string | number | boolean }
  | { assert: 'text_contains'; text: string }
  | { assert: 'text_not_contains'; text: string }
  | { assert: 'network_request'; method: HttpMethod; pathContains: string }
  | { assert: 'no_console_errors' };

export interface CaseSpec {
  /** Read before the steps and again after them, so a change is observable. */
  probes: Probe[];
  steps: Step[];
  assertions: Assertion[];
}

export interface GeneratedCase {
  title: string;
  /** `kind::identifier` of the enumerated surface this case is about. */
  surface: string;
  polarity: 'positive' | 'negative';
  statement: string;
  /** What the model claims this expectation rests on. Checked, never trusted. */
  claimedSource: ExpectationSource;
  /**
   * The enumerated identifiers and control labels the claim cites. This is the
   * evidence for `claimedSource`, and it is matched against what Shepard
   * actually enumerated rather than read as an assurance.
   */
  grounds: string[];
  spec: CaseSpec;
}

/** Everything a claimed source can be checked against. All of it mechanical. */
export interface Grounding {
  /** `kind::identifier` for every enumerated surface. */
  surfaceKeys: ReadonlySet<string>;
  /** Labels the crawler actually read off controls in the running application. */
  controlLabels: ReadonlySet<string>;
  /** Enumerated endpoints as `METHOD /path`. */
  endpoints: ReadonlySet<string>;
  routes: ReadonlySet<string>;
  /** Endpoints Shepard must not call, by identifier. */
  unsafeEndpoints: ReadonlySet<string>;
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Sources the model is not permitted to claim, and why.
 *
 * `invariant` and `history` are Shepard's own: an invariant is a rule that holds
 * for every application whatever its code says, and history is a comparison
 * against what Shepard itself recorded at the last baseline. Neither is
 * something a model can establish by asserting it, and if a model could claim
 * them it would claim them for everything, which would turn the anti-circularity
 * rule into decoration. `user_stated` requires a user to have stated something.
 */
const NOT_THE_MODELS_TO_CLAIM: ReadonlySet<ExpectationSource> =
  new Set<ExpectationSource>(['invariant', 'history', 'user_stated']);

export interface SourceRuling {
  source: ExpectationSource;
  demoted: boolean;
  why?: string;
}

/**
 * Decide what a generated expectation actually rests on.
 *
 * The anti-circularity rule in `verdict.ts` only means anything if the source
 * tag is earned. A model asked to label its own expectation will label it
 * independent, because that is the label that sounds right. So the label is
 * checked against mechanically enumerated fact, and a claim that does not hold
 * up is demoted to `code_derived` rather than rejected — a demoted case still
 * runs and can still catch a defect; what it loses is the ability to justify a
 * verdict of healthy.
 */
export function ruleOnSource(
  claimed: ExpectationSource,
  grounds: readonly string[],
  g: Grounding,
): SourceRuling {
  const demote = (why: string): SourceRuling => ({ source: 'code_derived', demoted: true, why });

  if (NOT_THE_MODELS_TO_CLAIM.has(claimed)) {
    return demote(`${claimed} is established by Shepard itself, not by a generated case`);
  }

  if (claimed === 'affordance') {
    // An affordance expectation rests on what a control promises the user. That
    // promise is the label, and the label has to be one the crawler actually
    // read off the running application — not one the model expected to be there.
    const cited = grounds.filter(x => g.controlLabels.has(norm(x)));
    return cited.length
      ? { source: 'affordance', demoted: false }
      : demote('no cited ground matches a control label Shepard observed');
  }

  if (claimed === 'cross_layer') {
    // Cross-layer evidence is two layers disagreeing, so it needs two layers.
    // One surface cited against itself is the implementation agreeing with
    // itself, which is the circularity this rule exists to catch.
    const kinds = new Set<string>();
    for (const x of grounds) {
      for (const key of g.surfaceKeys) {
        if (norm(key.split('::').slice(1).join('::')) === norm(x)) kinds.add(key.split('::')[0]!);
      }
      if (g.controlLabels.has(norm(x))) kinds.add('control');
    }
    return kinds.size >= 2
      ? { source: 'cross_layer', demoted: false }
      : demote(`cites ${kinds.size} layer(s); cross-layer evidence needs two that can disagree`);
  }

  return { source: 'code_derived', demoted: false };
}

export interface ValidationResult {
  ok: boolean;
  /** Why the case was refused. Recorded, because a refused case is a coverage gap. */
  why?: string;
}

/**
 * Refuse a case Shepard should not run.
 *
 * Two jobs. The first is shape: a spec referring to a probe that does not exist
 * would fail at run time and read as a defect in the application rather than a
 * defect in the case. The second is safety, and it is not negotiable by prompt:
 * an endpoint enumerated as unsafe is not called because the code here will not
 * call it, not because the model was asked nicely not to.
 */
export function validateCase(c: GeneratedCase, g: Grounding): ValidationResult {
  if (!c.spec || !Array.isArray(c.spec.steps) || !c.spec.steps.length) {
    return { ok: false, why: 'the case has no steps' };
  }
  if (!Array.isArray(c.spec.assertions) || !c.spec.assertions.length) {
    return { ok: false, why: 'the case asserts nothing, so it could not fail' };
  }

  const probeNames = new Set((c.spec.probes ?? []).map(p => p.name));

  for (const s of c.spec.steps) {
    if (s.do === 'request') {
      const identifier = `${s.method} ${s.path}`;
      if (g.unsafeEndpoints.has(identifier)) {
        return { ok: false, why: `${identifier} is enumerated as unsafe to call` };
      }
      if (!g.endpoints.has(identifier) && !g.routes.has(s.path)) {
        return { ok: false, why: `${identifier} was never enumerated, so Shepard will not call it` };
      }
    }
    if (s.do === 'click' && !g.controlLabels.has(norm(s.label))) {
      return { ok: false, why: `no control labelled "${s.label}" was observed` };
    }
  }

  for (const a of c.spec.assertions) {
    if ((a.assert === 'value_changed' || a.assert === 'value_equals') && !probeNames.has(a.probe)) {
      return { ok: false, why: `assertion refers to probe "${a.probe}", which the case does not read` };
    }
    if (a.assert === 'status' && a.probe && !probeNames.has(a.probe)) {
      return { ok: false, why: `assertion refers to probe "${a.probe}", which the case does not read` };
    }
  }

  return { ok: true };
}

/** Read a dot path out of a JSON body. `length` is allowed as a final segment. */
export function extract(body: unknown, path: string): unknown {
  let cur: unknown = body;
  for (const seg of path.split('.').filter(Boolean)) {
    if (cur == null) return undefined;
    if (seg === 'length' && Array.isArray(cur)) { cur = cur.length; continue; }
    if (seg === 'length' && typeof cur === 'string') { cur = cur.length; continue; }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
