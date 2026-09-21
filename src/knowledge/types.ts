export type Importance = 'core' | 'supporting' | 'peripheral';
export type Safety = 'safe' | 'sandbox_only' | 'unsafe' | 'unknown';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Outcome = 'pass' | 'fail' | 'inconclusive';
export type FindingStatus =
  | 'new' | 'known' | 'resolved' | 'recurrence' | 'intentional' | 'intermittent';

/**
 * Where an expectation came from. This is load-bearing rather than descriptive.
 *
 * A `code_derived` expectation is read from the same code that implements the
 * behaviour, so a defect in that code is inherited by the expectation. It can
 * show that the running app is *consistent with its implementation*, which is a
 * weaker claim than *correct*, and on its own it can never justify a healthy
 * verdict. See `justifiesHealthy` in ./verdict.ts.
 */
export type ExpectationSource =
  | 'affordance'    // a control labelled "Add to cart" must change the cart
  | 'cross_layer'   // schema vs API vs UI vs policy must agree
  | 'history'       // what this code did before
  | 'invariant'     // no inert control, no 4xx on a nominal journey, no console error
  | 'code_derived'  // supporting evidence only
  | 'user_stated';  // reconciled against observation, never taken as truth

export type SurfaceKind =
  | 'route' | 'control' | 'endpoint' | 'table' | 'policy' | 'integration' | 'job' | 'form';

/** The capability ladder. Failure to run an application is graduated, not binary. */
export enum Level {
  Static = 0,        // no execution; all behaviour unverified
  Builds = 1,        // install, typecheck and build succeed
  Boots = 2,         // server responds; routes and controls observable
  Persists = 3,      // database provisioned; database assertions possible
  Authenticated = 4, // test identities exist per role; auth matrix testable
  Integrated = 5,    // outbound calls stubbed and observable
}

export const LEVEL_NAMES: Record<Level, string> = {
  [Level.Static]: 'static only',
  [Level.Builds]: 'builds',
  [Level.Boots]: 'boots',
  [Level.Persists]: 'persists',
  [Level.Authenticated]: 'authenticated',
  [Level.Integrated]: 'integrated',
};

export interface ProvenanceInput {
  kind: 'parse' | 'crawl' | 'browser' | 'shell' | 'query' | 'model';
  tool: string;
  detail?: string;
  evidenceId?: string;
  atCommit?: string;
}

export interface SurfaceRow {
  id: string;
  app_id: string;
  system_id: string | null;
  kind: SurfaceKind;
  identifier: string;
  label: string | null;
  location: string | null;
  safety: Safety;
  importance: Importance;
  provenance_id: string;
  at_commit: string | null;
  stale: number;
}

export interface FindingRow {
  id: string;
  app_id: string;
  fingerprint: string;
  surface_id: string | null;
  class: string;
  title: string;
  expected: string | null;
  observed: string | null;
  impact: string | null;
  cause: string | null;
  severity: Severity;
  status: FindingStatus;
  first_seen: string;
  last_seen: string;
  confirmations: number;
}
