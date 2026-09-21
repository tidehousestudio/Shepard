import type { ExpectationSource } from './types.js';

/**
 * Verified healthy, verified broken and unverified are three different states,
 * and the third never silently becomes the first.
 */
export type Verdict =
  | { state: 'verified_healthy'; sources: ExpectationSource[] }
  | { state: 'verified_broken'; sources: ExpectationSource[] }
  | { state: 'consistent_only'; sources: ExpectationSource[]; why: string }
  | { state: 'unverified'; why: string };

/**
 * Expectation sources that are independent of the implementation under test.
 *
 * `code_derived` is deliberately absent. An expectation read from the same code
 * that implements the behaviour inherits any defect in that code: delete a click
 * handler and the code-derived expectation becomes "this button does nothing",
 * which the running application satisfies perfectly. Shepard would then report a
 * planted defect as healthy.
 */
const INDEPENDENT: ReadonlySet<ExpectationSource> = new Set<ExpectationSource>([
  'affordance', 'cross_layer', 'history', 'invariant',
]);

/**
 * The anti-circularity rule, as a function rather than a paragraph in a design
 * document, so that nothing in Shepard can quietly route around it.
 *
 * A passing observation only justifies *verified healthy* when at least one
 * expectation behind it came from outside the implementation. Otherwise the most
 * Shepard may claim is that the application is consistent with its own code,
 * which is a weaker statement and is reported as such.
 *
 * `user_stated` is excluded too: a human saying behaviour is intended is a claim
 * to reconcile against observation, not technical truth.
 */
export function justifiesHealthy(sources: readonly ExpectationSource[]): boolean {
  return sources.some(s => INDEPENDENT.has(s));
}

export function verdictFor(
  passed: boolean,
  sources: readonly ExpectationSource[],
  opts: { reason?: string } = {},
): Verdict {
  const list = [...sources];

  if (list.length === 0) {
    return { state: 'unverified', why: opts.reason ?? 'no expectation was established for this surface' };
  }

  // A failure is a failure whatever established the expectation: if the code
  // says the button posts an order and no request leaves the browser, the
  // application disagrees with itself, and that is worth reporting either way.
  if (!passed) return { state: 'verified_broken', sources: list };

  if (!justifiesHealthy(list)) {
    return {
      state: 'consistent_only',
      sources: list,
      why: 'every expectation was derived from the implementation under test, '
         + 'so this shows consistency with the code rather than correctness',
    };
  }

  return { state: 'verified_healthy', sources: list };
}

/** Only genuinely verified health counts towards coverage. */
export function countsAsVerified(v: Verdict): boolean {
  return v.state === 'verified_healthy' || v.state === 'verified_broken';
}
