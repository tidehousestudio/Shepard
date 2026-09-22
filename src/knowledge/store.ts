import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ProvenanceInput, SurfaceKind, Safety, Importance, Severity,
  Outcome, FindingRow, SurfaceRow, ExpectationSource,
} from './types.js';
import { Level } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const now = (): string => new Date().toISOString();
const id = (): string => randomUUID();

/**
 * Shepard's memory.
 *
 * The working context of a model is not memory: it compacts, it resets, it is
 * replaced. Everything Shepard needs in a later session lives here, including
 * the state of its own unfinished investigations.
 *
 * The store enforces one invariant that the rest of the system relies on:
 * nothing gets written as a claim without provenance. If Shepard cannot say
 * which tool output produced a belief, it does not get to hold that belief.
 */
export class KnowledgeStore {
  readonly db: Database.Database;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  }

  close(): void { this.db.close(); }

  // ---- applications -------------------------------------------------------

  createApplication(input: { name: string; rootPath: string; repoUrl?: string; headCommit?: string }): string {
    const appId = id();
    this.db.prepare(
      `INSERT INTO application (id, name, repo_url, root_path, head_commit, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(appId, input.name, input.repoUrl ?? null, input.rootPath, input.headCommit ?? null, now());
    return appId;
  }

  findApplicationByRoot(rootPath: string): { id: string; name: string; head_commit: string | null } | undefined {
    return this.db.prepare(
      `SELECT id, name, head_commit FROM application WHERE root_path = ?`,
    ).get(rootPath) as any;
  }

  setHeadCommit(appId: string, commit: string): void {
    this.db.prepare(`UPDATE application SET head_commit = ? WHERE id = ?`).run(commit, appId);
  }

  // ---- provenance ---------------------------------------------------------

  /** Record the tool invocation behind a claim. Every claim needs one. */
  recordProvenance(appId: string, p: ProvenanceInput): string {
    const provId = id();
    this.db.prepare(
      `INSERT INTO provenance (id, app_id, kind, tool, detail, evidence_id, at_commit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(provId, appId, p.kind, p.tool, p.detail ?? null, p.evidenceId ?? null, p.atCommit ?? null, now());
    return provId;
  }

  // ---- evidence -----------------------------------------------------------

  registerEvidence(appId: string, e: {
    content: Buffer; kind: string; path: string; meta?: unknown;
  }): string {
    const hash = createHash('sha256').update(e.content).digest('hex');
    this.db.prepare(
      `INSERT OR IGNORE INTO evidence (id, app_id, kind, path, bytes, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(hash, appId, e.kind, e.path, e.content.length, e.meta ? JSON.stringify(e.meta) : null, now());
    return hash;
  }

  // ---- the verification surface ------------------------------------------

  /**
   * Surfaces are produced by parsers and crawlers, never by a model.
   *
   * A model notices anomalies well and notices absence badly: it will spot a
   * strange line in a file but not that a control has no handler. Absence is the
   * shape of most defects, so enumeration is mechanical and the model is only
   * ever asked about items that are already on the list.
   */
  upsertSurface(appId: string, s: {
    kind: SurfaceKind; identifier: string; label?: string; location?: string;
    safety?: Safety; importance?: Importance; systemId?: string;
    provenanceId: string; atCommit?: string; attributes?: Record<string, unknown>;
  }): string {
    const existing = this.db.prepare(
      `SELECT id FROM surface WHERE app_id = ? AND kind = ? AND identifier = ?`,
    ).get(appId, s.kind, s.identifier) as { id: string } | undefined;

    const attrs = s.attributes ? JSON.stringify(s.attributes) : null;

    if (existing) {
      this.db.prepare(
        `UPDATE surface SET label = ?, location = ?, safety = ?, importance = ?,
                            provenance_id = ?, at_commit = ?, stale = 0, attributes = ?
         WHERE id = ?`,
      ).run(s.label ?? null, s.location ?? null, s.safety ?? 'unknown',
            s.importance ?? 'supporting', s.provenanceId, s.atCommit ?? null, attrs, existing.id);
      return existing.id;
    }

    const sid = id();
    this.db.prepare(
      `INSERT INTO surface (id, app_id, system_id, kind, identifier, label, location,
                            safety, importance, provenance_id, at_commit, attributes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sid, appId, s.systemId ?? null, s.kind, s.identifier, s.label ?? null,
          s.location ?? null, s.safety ?? 'unknown', s.importance ?? 'supporting',
          s.provenanceId, s.atCommit ?? null, attrs);
    return sid;
  }

  /**
   * What Shepard believed about each surface before this audit began.
   *
   * Read before the new enumeration overwrites it. This is the only place the
   * previous shape of the application survives, and a defect that deletes its
   * own expectation can only be caught by comparing against it.
   */
  priorAttributes(appId: string): Map<string, Record<string, unknown>> {
    const rows = this.db.prepare(
      `SELECT kind, identifier, attributes FROM surface WHERE app_id = ? AND attributes IS NOT NULL`,
    ).all(appId) as { kind: string; identifier: string; attributes: string }[];
    const out = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      try { out.set(`${r.kind}::${r.identifier}`, JSON.parse(r.attributes)); } catch { /* ignore */ }
    }
    return out;
  }

  surfaces(appId: string, kind?: SurfaceKind): SurfaceRow[] {
    return (kind
      ? this.db.prepare(`SELECT * FROM surface WHERE app_id = ? AND kind = ? ORDER BY identifier`).all(appId, kind)
      : this.db.prepare(`SELECT * FROM surface WHERE app_id = ? ORDER BY kind, identifier`).all(appId)
    ) as SurfaceRow[];
  }

  surfaceCounts(appId: string): Record<string, number> {
    const rows = this.db.prepare(
      `SELECT kind, COUNT(*) AS n FROM surface WHERE app_id = ? GROUP BY kind`,
    ).all(appId) as { kind: string; n: number }[];
    return Object.fromEntries(rows.map(r => [r.kind, r.n]));
  }

  /**
   * Mark claims derived before a commit as stale so they are re-derived rather
   * than inherited. Shepard's own knowledge is a source of error over time.
   */
  markStaleBefore(appId: string, commit: string): number {
    let total = 0;
    for (const t of ['surface', 'expectation', 'system', 'actor', 'journey', 'verification_case']) {
      const r = this.db.prepare(
        `UPDATE ${t} SET stale = 1 WHERE app_id = ? AND (at_commit IS NULL OR at_commit != ?)`,
      ).run(appId, commit);
      total += r.changes;
    }
    return total;
  }

  // ---- comprehension (systems and actors) --------------------------------

  /**
   * Persist what the model understood about the application.
   *
   * Understanding is only worth anything if it survives the conversation that
   * produced it, so systems and actors are rows with provenance like everything
   * else — a later session, or the chat, reads them from here rather than
   * re-deriving them. Replaced wholesale each comprehension, because a changed
   * application can retire a system, and a stale system left behind would be a
   * claim with nothing behind it.
   */
  replaceComprehension(appId: string, c: {
    systems: { name: string; importance: Importance; summary?: string }[];
    actors: { name: string; credentials?: string }[];
    provenanceId: string;
    atCommit?: string;
  }): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM system WHERE app_id = ?`).run(appId);
      this.db.prepare(`DELETE FROM actor WHERE app_id = ?`).run(appId);
      const insSystem = this.db.prepare(
        `INSERT INTO system (id, app_id, name, summary, importance, provenance_id, at_commit)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of c.systems) {
        insSystem.run(id(), appId, s.name, s.summary ?? null, s.importance, c.provenanceId, c.atCommit ?? null);
      }
      const insActor = this.db.prepare(
        `INSERT INTO actor (id, app_id, name, credentials, provenance_id, at_commit)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const a of c.actors) {
        insActor.run(id(), appId, a.name, a.credentials ?? null, c.provenanceId, c.atCommit ?? null);
      }
    });
    tx();
  }

  systems(appId: string): { name: string; summary: string | null; importance: string }[] {
    return this.db.prepare(
      `SELECT name, summary, importance FROM system WHERE app_id = ? ORDER BY
         CASE importance WHEN 'core' THEN 0 WHEN 'supporting' THEN 1 ELSE 2 END, name`,
    ).all(appId) as any;
  }

  actors(appId: string): { name: string }[] {
    return this.db.prepare(`SELECT name FROM actor WHERE app_id = ? ORDER BY name`).all(appId) as any;
  }

  // ---- expectations -------------------------------------------------------

  addExpectation(appId: string, e: {
    surfaceId: string; source: ExpectationSource; statement: string;
    predicate: unknown; provenanceId: string; atCommit?: string;
  }): string {
    const eid = id();
    this.db.prepare(
      `INSERT INTO expectation (id, app_id, surface_id, source, statement, predicate, provenance_id, at_commit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(eid, appId, e.surfaceId, e.source, e.statement, JSON.stringify(e.predicate),
          e.provenanceId, e.atCommit ?? null);
    return eid;
  }

  expectationSourcesFor(surfaceId: string): ExpectationSource[] {
    return (this.db.prepare(
      `SELECT DISTINCT source FROM expectation WHERE surface_id = ?`,
    ).all(surfaceId) as { source: ExpectationSource }[]).map(r => r.source);
  }

  // ---- cycles, runs, observations ----------------------------------------

  startCycle(appId: string, kind: string, atCommit?: string, level: Level = Level.Static): string {
    const cid = id();
    this.db.prepare(
      `INSERT INTO audit_cycle (id, app_id, kind, at_commit, level, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(cid, appId, kind, atCommit ?? null, level, now());
    return cid;
  }

  endCycle(cycleId: string, level: Level, summary: unknown): void {
    this.db.prepare(
      `UPDATE audit_cycle SET ended_at = ?, level = ?, summary = ? WHERE id = ?`,
    ).run(now(), level, JSON.stringify(summary), cycleId);
  }

  recordRun(appId: string, r: {
    cycleId?: string; caseId?: string; outcome: Outcome; reason?: string; attempt?: number;
    observations?: { key: string; value?: string; evidenceId?: string }[];
  }): string {
    const rid = id();
    const t = now();
    this.db.prepare(
      `INSERT INTO run (id, app_id, cycle_id, case_id, started_at, ended_at, outcome, reason, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(rid, appId, r.cycleId ?? null, r.caseId ?? null, t, t, r.outcome, r.reason ?? null, r.attempt ?? 1);
    const ins = this.db.prepare(
      `INSERT INTO observation (id, run_id, key, value, evidence_id) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const o of r.observations ?? []) ins.run(id(), rid, o.key, o.value ?? null, o.evidenceId ?? null);
    return rid;
  }

  // ---- findings -----------------------------------------------------------

  /**
   * Record an observed defect against its fingerprint, computing its lifecycle
   * state rather than guessing it. A finding that was resolved and has come back
   * is a recurrence, which is a different and more serious thing than a new one.
   */
  observeFinding(appId: string, f: {
    fingerprint: string; surfaceId?: string; class: string; title: string;
    expected?: string; observed?: string; impact?: string; cause?: string;
    severity: Severity; runId?: string;
  }): { findingId: string; status: string; isNew: boolean } {
    const t = now();
    const prior = this.db.prepare(
      `SELECT * FROM finding WHERE app_id = ? AND fingerprint = ?`,
    ).get(appId, f.fingerprint) as FindingRow | undefined;

    const muted = this.db.prepare(
      `SELECT id FROM exception WHERE app_id = ? AND fingerprint = ? AND status = 'active'`,
    ).get(appId, f.fingerprint) as { id: string } | undefined;

    if (!prior) {
      const fid = id();
      const status = muted ? 'intentional' : 'new';
      this.db.prepare(
        `INSERT INTO finding (id, app_id, fingerprint, surface_id, class, title, expected,
                              observed, impact, cause, severity, status, first_seen, last_seen, confirmations)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(fid, appId, f.fingerprint, f.surfaceId ?? null, f.class, f.title, f.expected ?? null,
            f.observed ?? null, f.impact ?? null, f.cause ?? null, f.severity, status, t, t);
      this.addFindingEvent(fid, 'observed', f.runId, 'first observation');
      return { findingId: fid, status, isNew: true };
    }

    const status = muted ? 'intentional' : prior.status === 'resolved' ? 'recurrence' : 'known';
    this.db.prepare(
      `UPDATE finding SET last_seen = ?, status = ?, observed = ?, severity = ?,
                          confirmations = confirmations + 1
       WHERE id = ?`,
    ).run(t, status, f.observed ?? prior.observed, f.severity, prior.id);
    this.addFindingEvent(prior.id, status === 'recurrence' ? 'recurred' : 'observed', f.runId);
    return { findingId: prior.id, status, isNew: false };
  }

  /** Anything not seen in this cycle that was previously open is now resolved. */
  resolveUnseen(appId: string, seenFingerprints: string[]): number {
    const placeholders = seenFingerprints.map(() => '?').join(',') || "''";
    const rows = this.db.prepare(
      `SELECT id FROM finding
        WHERE app_id = ? AND status IN ('new','known','recurrence')
          AND fingerprint NOT IN (${placeholders})`,
    ).all(appId, ...seenFingerprints) as { id: string }[];
    for (const r of rows) {
      this.db.prepare(`UPDATE finding SET status = 'resolved', last_seen = ? WHERE id = ?`).run(now(), r.id);
      this.addFindingEvent(r.id, 'resolved', undefined, 'not observed in this cycle');
    }
    return rows.length;
  }

  addFindingEvent(findingId: string, kind: string, runId?: string, note?: string): void {
    this.db.prepare(
      `INSERT INTO finding_event (id, finding_id, run_id, kind, at, note) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id(), findingId, runId ?? null, kind, now(), note ?? null);
  }

  findings(appId: string, opts: { open?: boolean } = {}): FindingRow[] {
    return (opts.open
      ? this.db.prepare(
          `SELECT * FROM finding WHERE app_id = ? AND status IN ('new','known','recurrence','intermittent')
           ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
                                  WHEN 'low' THEN 3 ELSE 4 END, last_seen DESC`).all(appId)
      : this.db.prepare(`SELECT * FROM finding WHERE app_id = ? ORDER BY last_seen DESC`).all(appId)
    ) as FindingRow[];
  }

  // ---- acquisition, baselines, investigations, blind spots ---------------

  recordAcquisition(appId: string, a: {
    level: Level; recipe?: unknown; unmet?: unknown; baseUrl?: string; atCommit?: string;
  }): string {
    const aid = id();
    this.db.prepare(
      `INSERT INTO acquisition (id, app_id, at_commit, level, recipe, unmet, base_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(aid, appId, a.atCommit ?? null, a.level,
          a.recipe ? JSON.stringify(a.recipe) : null,
          a.unmet ? JSON.stringify(a.unmet) : null, a.baseUrl ?? null, now());
    return aid;
  }

  latestAcquisition(appId: string): { level: number; unmet: string | null; base_url: string | null } | undefined {
    return this.db.prepare(
      `SELECT level, unmet, base_url FROM acquisition WHERE app_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(appId) as any;
  }

  recordBaseline(appId: string, b: { atCommit: string; state: string; manifest: unknown; reason?: string }): string {
    const bid = id();
    this.db.prepare(
      `INSERT INTO baseline (id, app_id, at_commit, created_at, state, manifest, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(bid, appId, b.atCommit, now(), b.state, JSON.stringify(b.manifest), b.reason ?? null);
    this.db.prepare(
      `UPDATE application SET accept_state = ?, accepted_at = ? WHERE id = ?`,
    ).run(b.state === 'denied' ? 'denied' : b.state, b.state === 'denied' ? null : now(), appId);
    return bid;
  }

  openInvestigation(appId: string, i: { question: string; cycleId?: string; nextProbe?: string }): string {
    const iid = id();
    const t = now();
    this.db.prepare(
      `INSERT INTO investigation (id, app_id, cycle_id, question, hypotheses, ruled_out, next_probe,
                                  status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '[]', ?, 'open', ?, ?)`,
    ).run(iid, appId, i.cycleId ?? null, i.question, i.nextProbe ?? null, t, t);
    return iid;
  }

  recordBlindSpot(b: { appId?: string; class: string; missed: string; why: string; heuristic: string }): string {
    const bid = id();
    this.db.prepare(
      `INSERT INTO blind_spot (id, app_id, class, missed, why, heuristic, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(bid, b.appId ?? null, b.class, b.missed, b.why, b.heuristic, now());
    return bid;
  }
}
