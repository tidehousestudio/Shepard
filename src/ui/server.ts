import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeStore } from '../knowledge/store.js';
import { LEVEL_NAMES, Level } from '../knowledge/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * Shepard's state, as the screen needs it.
 *
 * Note what is absent: there is no "last command succeeded" field. Health is
 * what Shepard currently believes about the application, derived from the
 * knowledge store, and `blind` is a first-class state so that an audit which
 * could not run never renders as an application that is fine.
 */
export interface UiState {
  connected: boolean;
  repository: string | null;
  health: 'healthy' | 'degraded' | 'critical' | 'blind' | 'onboarding';
  coverage: number;
  level: string;
  lastAudit: string | null;
  critical: number;
  needAttention: number;
  unverified: string[];
  findings: { severity: string; status: string; title: string }[];
}

export function readState(repoRoot: string): UiState {
  const dbPath = join(repoRoot, '.shepard', 'knowledge.db');
  if (!existsSync(dbPath)) {
    return {
      connected: false, repository: null, health: 'blind', coverage: 0,
      level: 'unknown', lastAudit: null, critical: 0, needAttention: 0,
      unverified: [], findings: [],
    };
  }

  const store = new KnowledgeStore(dbPath);
  const app = store.findApplicationByRoot(repoRoot);
  if (!app) {
    store.close();
    return {
      connected: false, repository: null, health: 'blind', coverage: 0,
      level: 'unknown', lastAudit: null, critical: 0, needAttention: 0,
      unverified: [], findings: [],
    };
  }

  const cycle = store.db.prepare(
    `SELECT ended_at, summary, level FROM audit_cycle WHERE app_id = ? ORDER BY started_at DESC LIMIT 1`,
  ).get(app.id) as { ended_at: string | null; summary: string | null; level: number } | undefined;

  const baseline = store.db.prepare(
    `SELECT manifest FROM baseline WHERE app_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(app.id) as { manifest: string } | undefined;

  const open = store.findings(app.id, { open: true });
  const summary = cycle?.summary ? JSON.parse(cycle.summary) : null;
  const manifest = baseline?.manifest ? JSON.parse(baseline.manifest) : null;

  const state: UiState = {
    connected: true,
    repository: app.name,
    health: cycle?.ended_at ? (summary?.state ?? 'blind') : 'onboarding',
    coverage: summary?.coverage ?? 0,
    level: LEVEL_NAMES[(cycle?.level ?? 0) as Level] ?? 'unknown',
    lastAudit: cycle?.ended_at ?? null,
    critical: open.filter(f => f.severity === 'critical').length,
    needAttention: open.filter(f => f.severity !== 'critical' && f.severity !== 'info').length,
    unverified: manifest?.knownUnverified ?? [],
    findings: open.map(f => ({ severity: f.severity, status: f.status, title: f.title })),
  };

  store.close();
  return state;
}

export function serve(repoRoot: string, port: number): void {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(readState(repoRoot)));
      return;
    }

    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const path = join(HERE, 'public', file);
    if (!path.startsWith(join(HERE, 'public')) || !existsSync(path)) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'text/plain' });
    res.end(readFileSync(path));
  });

  server.listen(port, () => {
    process.stdout.write(`\nshepard is watching. http://127.0.0.1:${port}\n\n`);
  });
}
