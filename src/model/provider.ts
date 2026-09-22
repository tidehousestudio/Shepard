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
  /**
   * Prove model access, cheaply, without auditing anything.
   *
   * A key that is present is not a key that works, and the difference has cost
   * this project two audit attempts. So this spends one minimal request and
   * reports what the API said, rather than inferring from the key's presence.
   */
  verify(): Promise<void>;
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

  async verify(): Promise<void> {
    throw new Error('no model provider is configured');
  }

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
 * The variables Shepard will take a key from, in order of preference.
 *
 * `SHEPARD_ANTHROPIC_API_KEY` is first and is the name to prefer. `ANTHROPIC_API_KEY`
 * is not Shepard's to claim: the Claude Code CLI reads that same name for its own
 * inference and, when it is set, uses it instead of the signed-in subscription. So a
 * key parked under that name to feed Shepard silently changes who pays for every
 * other agent running in the same container. A private name takes the key to Shepard
 * and to nothing else. The generic name stays supported for a plain local shell.
 */
const KEY_VARS = ['SHEPARD_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'] as const;

/** Which of `KEY_VARS` is set, if any. The name only — never the value. */
export function keySource(): string | undefined {
  return KEY_VARS.find(name => (process.env[name] ?? '').trim().length > 0);
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
  const source = keySource();
  if (!source) return new HeuristicProvider();
  const { ClaudeProvider } = await import('./claude.js');
  return new ClaudeProvider((process.env[source] as string).trim());
}
