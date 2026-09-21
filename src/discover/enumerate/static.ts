import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Inventory } from '../inventory.js';
import type { SurfaceKind, Safety } from '../../knowledge/types.js';

export interface DiscoveredSurface {
  kind: SurfaceKind;
  identifier: string;
  label?: string;
  location?: string;
  safety?: Safety;
  via: string;        // which enumerator found it, for provenance
  /** The code contains an authorization check for this surface. Cross-layer evidence. */
  guarded?: boolean;
}

const read = (root: string, rel: string): string => {
  try { return readFileSync(join(root, rel), 'utf8'); } catch { return ''; }
};

/** Routes from a Next.js app/ or pages/ directory. */
function nextRoutes(inv: Inventory): DiscoveredSurface[] {
  const out: DiscoveredSurface[] = [];
  for (const f of inv.files) {
    let m = /^(?:src\/)?app\/(.*)\/(page|route)\.(tsx?|jsx?)$/.exec(f);
    if (m) {
      const segs = m[1]!.split('/').filter(s => s && !/^\(.*\)$/.test(s));
      const path = '/' + segs.join('/');
      out.push({
        kind: m[2] === 'route' ? 'endpoint' : 'route',
        identifier: path === '/' ? '/' : path,
        location: f, via: 'next-app-router',
        safety: m[2] === 'route' ? 'unknown' : 'safe',
      });
      continue;
    }
    m = /^(?:src\/)?pages\/(.+)\.(tsx?|jsx?)$/.exec(f);
    if (m && !m[1]!.startsWith('_')) {
      const p = m[1]!.replace(/\/index$/, '') || 'index';
      const isApi = p.startsWith('api/');
      out.push({
        kind: isApi ? 'endpoint' : 'route',
        identifier: '/' + (p === 'index' ? '' : p),
        location: f, via: 'next-pages-router',
        safety: isApi ? 'unknown' : 'safe',
      });
    }
  }
  return out;
}

/** Routes declared with react-router, wherever they are declared. */
function reactRouterRoutes(inv: Inventory): DiscoveredSurface[] {
  const out: DiscoveredSurface[] = [];
  for (const f of inv.files) {
    if (!/\.(tsx?|jsx?)$/.test(f)) continue;
    const src = read(inv.root, f);
    if (!/react-router|createBrowserRouter|<Route\b/.test(src)) continue;
    for (const m of src.matchAll(/<Route\s+[^>]*path\s*=\s*["'`]([^"'`]+)["'`]/g)) {
      out.push({ kind: 'route', identifier: m[1]!, location: f, via: 'react-router-jsx', safety: 'safe' });
    }
    for (const m of src.matchAll(/\bpath\s*:\s*["'`]([^"'`]+)["'`]/g)) {
      out.push({ kind: 'route', identifier: m[1]!, location: f, via: 'react-router-object', safety: 'safe' });
    }
  }
  return out;
}

/** Express and Fastify handlers. */
function serverEndpoints(inv: Inventory): DiscoveredSurface[] {
  const out: DiscoveredSurface[] = [];
  const verb = /\b(?:app|router|server|fastify)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  for (const f of inv.files) {
    if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(f)) continue;
    const src = read(inv.root, f);
    for (const m of src.matchAll(verb)) {
      const method = m[1]!.toUpperCase();
      const urlPath = m[2]!;
      const readOnly = method === 'GET' || method === 'HEAD';
      // A GET outside an API prefix is a page a user can be standing on, not
      // just a function. Classifying it as a route is what puts it in the crawl
      // queue, and a route nobody visits is a route nobody verifies.
      const servesPage = readOnly && !/^\/(api|v\d+|graphql|rpc)\b/.test(urlPath) && !/\.\w+$/.test(urlPath);
      // Look at the handler body for an authorization check. This is what turns
      // "the path is called /admin" into evidence that the code intends to
      // protect it, which is the difference between a hint and a finding.
      const body = src.slice(m.index, m.index + 400);
      const guarded = /\b(req\.headers|authorization|bearer|session|currentUser|requireAuth|isAdmin|role|token|auth)\b/i.test(body);
      out.push({
        kind: servesPage ? 'route' : 'endpoint',
        identifier: servesPage ? urlPath : `${method} ${urlPath}`,
        location: f, via: 'express-fastify',
        // Anything that writes is not assumed safe until Shepard knows what it touches.
        safety: readOnly ? 'safe' : 'unknown',
        guarded,
      });
    }
  }
  return out;
}

/** Supabase edge functions. */
function edgeFunctions(inv: Inventory): DiscoveredSurface[] {
  return inv.files
    .filter(f => /^supabase\/functions\/[^/]+\/index\.ts$/.test(f))
    .map(f => ({
      kind: 'endpoint' as const,
      identifier: 'FN ' + f.split('/')[2],
      location: f, via: 'supabase-edge-function', safety: 'unknown' as const,
    }));
}

/**
 * Tables and row-level security policies from SQL migrations.
 *
 * Policies matter more than tables: an access policy that exists in the schema
 * but is never exercised by any tested surface is exactly the kind of gap that
 * only shows up when two layers are compared against each other.
 */
function databaseObjects(inv: Inventory): DiscoveredSurface[] {
  const out: DiscoveredSurface[] = [];
  for (const f of inv.files) {
    if (!f.endsWith('.sql')) continue;
    const src = read(inv.root, f);
    for (const m of src.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["']?([\w.]+)["']?/gi)) {
      out.push({ kind: 'table', identifier: m[1]!.replace(/^public\./, ''), location: f, via: 'sql-migration' });
    }
    for (const m of src.matchAll(/create\s+policy\s+["']([^"']+)["']\s+on\s+["']?([\w.]+)["']?/gi)) {
      out.push({
        kind: 'policy', identifier: `${m[2]!.replace(/^public\./, '')}:${m[1]}`,
        label: m[1]!, location: f, via: 'sql-policy',
      });
    }
  }
  return out;
}

/**
 * Outbound integrations, found by the clients the code imports.
 *
 * These are enumerated so they can be classified for safety, not so they can be
 * called: anything that charges money or sends a message is stubbed at the
 * network boundary and verified by what it *would* have sent.
 */
function integrations(inv: Inventory): DiscoveredSurface[] {
  const known: [RegExp, string, Safety][] = [
    [/\bstripe\b/i, 'stripe', 'unsafe'],
    [/\b(sendgrid|postmark|resend|mailgun|nodemailer)\b/i, 'email', 'unsafe'],
    [/\btwilio\b/i, 'sms', 'unsafe'],
    [/\b(s3|cloudinary|uploadthing)\b/i, 'storage', 'sandbox_only'],
    [/\bsupabase\b/i, 'supabase', 'sandbox_only'],
    [/\bopenai|anthropic\b/i, 'model-api', 'sandbox_only'],
  ];
  const found = new Map<string, DiscoveredSurface>();
  for (const f of inv.files) {
    if (!/\.(tsx?|jsx?|mjs|cjs|py|rb)$/.test(f)) continue;
    const src = read(inv.root, f);
    const imports = src.match(/^\s*(?:import .*from\s+["'].*["']|.*require\(["'].*["']\))/gm)?.join('\n') ?? '';
    for (const [re, name, safety] of known) {
      if (re.test(imports) && !found.has(name)) {
        found.set(name, { kind: 'integration', identifier: name, location: f, via: 'import-scan', safety });
      }
    }
  }
  return [...found.values()];
}

/**
 * Enumerate everything statically discoverable.
 *
 * Deliberately plural and deliberately overlapping: several enumerators may find
 * the same surface by different means, and that agreement is itself evidence.
 * Where they disagree, the disagreement is the interesting part.
 */
export function enumerateStatic(inv: Inventory): DiscoveredSurface[] {
  const all = [
    ...nextRoutes(inv),
    ...reactRouterRoutes(inv),
    ...serverEndpoints(inv),
    ...edgeFunctions(inv),
    ...databaseObjects(inv),
    ...integrations(inv),
  ];
  const seen = new Map<string, DiscoveredSurface>();
  for (const s of all) {
    const key = `${s.kind}::${s.identifier}`;
    if (!seen.has(key)) seen.set(key, s);
  }
  return [...seen.values()];
}
