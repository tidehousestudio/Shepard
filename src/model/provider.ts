import type { Inventory } from '../discover/inventory.js';
import type { DiscoveredSurface } from '../discover/enumerate/static.js';

export interface Comprehension {
  name: string;
  summary: string;
  actors: { name: string; evidence: string }[];
  systems: { name: string; importance: 'core' | 'supporting' | 'peripheral'; evidence: string }[];
  available: boolean;     // false when no model was available to produce this
  producedBy: string;
}

/**
 * The seam between Shepard's mechanical half and its judging half.
 *
 * Detection does not need a model: enumeration, booting, browser execution,
 * database assertions and every universal invariant are mechanical. A model is
 * needed to say what an application *is* and what a surface is *for*. Keeping
 * that behind one interface means Shepard runs honestly without a key and gains
 * understanding when it has one, rather than being blocked on credentials.
 */
export interface ModelProvider {
  readonly name: string;
  readonly available: boolean;
  comprehend(inv: Inventory, surfaces: DiscoveredSurface[]): Promise<Comprehension>;
}

/**
 * Structure without understanding.
 *
 * This provider does not pretend to know what an application does. It groups
 * what was mechanically enumerated and says plainly that no model produced it,
 * so that a report generated without a key can never be mistaken for one that
 * was actually reasoned about.
 */
export class HeuristicProvider implements ModelProvider {
  readonly name = 'heuristic (no model)';
  readonly available = false;

  async comprehend(inv: Inventory, surfaces: DiscoveredSurface[]): Promise<Comprehension> {
    const byKind = (k: string) => surfaces.filter(s => s.kind === k);
    const systems: Comprehension['systems'] = [];

    const groups = new Map<string, number>();
    for (const r of byKind('route')) {
      const seg = r.identifier.split('/').filter(Boolean)[0] ?? 'root';
      groups.set(seg, (groups.get(seg) ?? 0) + 1);
    }
    for (const [seg, n] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      systems.push({
        name: seg === 'root' ? 'top level' : seg,
        importance: n >= 3 ? 'core' : 'supporting',
        evidence: `${n} route(s) under /${seg === 'root' ? '' : seg}`,
      });
    }

    // Roles inferred from access policies are structural, not interpretive: the
    // policy names are in the schema.
    const actors = [...new Set(byKind('policy').map(p => p.label ?? p.identifier))]
      .slice(0, 10)
      .map(p => ({ name: p, evidence: 'named in a row-level security policy' }));

    return {
      name: inv.root.split('/').filter(Boolean).pop() ?? 'application',
      summary:
        `Structural summary only. ${surfaces.length} surfaces enumerated across `
        + `${[...new Set(surfaces.map(s => s.kind))].join(', ')}. `
        + `No model was available, so Shepard has not formed an understanding of what this application is for.`,
      actors, systems, available: false,
      producedBy: this.name,
    };
  }
}

/**
 * Choose a provider from what the environment actually offers.
 *
 * With a key, Shepard understands; without one, it reports structure and says
 * plainly that it formed no understanding. The choice is made from the presence
 * of the key alone, and never degrades silently: behaviour Shepard could not
 * reason about must never read as behaviour it understood.
 *
 * The import is dynamic so that the mechanical half of Shepard — every phase that
 * needs no key — carries no dependency on the model SDK. This is loaded through
 * `selectProvider` (async) only when a key is present.
 */
export async function selectProvider(): Promise<ModelProvider> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return new HeuristicProvider();
  const { ClaudeProvider } = await import('./claude.js');
  return new ClaudeProvider(key);
}
