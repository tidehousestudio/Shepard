import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Inventory } from '../discover/inventory.js';
import type { DiscoveredSurface } from '../discover/enumerate/static.js';
import type { Comprehension, ModelProvider } from './provider.js';

const MODEL = 'claude-opus-5';

/**
 * The judging half of Shepard.
 *
 * Detection is mechanical and runs without this. What a model is actually needed
 * for is judgement: saying what an application *is* and what a surface is *for*.
 * So this provider is given only what was mechanically discovered and asked to
 * name it — never to find it. Enumeration stays with the parsers, because absence
 * is what a model misses, and understanding stays here, where it belongs.
 *
 * The call is deliberately shaped the way the whole system is:
 *
 *  - Bounded. One request with a retrieved slice of context — the inventory and
 *    the enumerated surface — not a long conversation that drifts.
 *  - Typed. Structured output, so the result is rows Shepard can act on rather
 *    than prose it has to re-parse. The understanding report the user reads is
 *    rendered from these rows; a claim with no row behind it does not get made.
 *  - Grounded. The prompt forbids inventing systems or actors that the provided
 *    evidence does not support, because a confident wrong answer is worse than
 *    an honest "structure only".
 */
export class ClaudeProvider implements ModelProvider {
  readonly name = `claude (${MODEL})`;
  readonly available = true;
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  /** One minimal request, to establish that the key is accepted. */
  async verify(): Promise<void> {
    await this.client.messages.create({
      model: MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ok' }],
    });
  }

  async comprehend(inv: Inventory, surfaces: DiscoveredSurface[]): Promise<Comprehension> {
    const evidence = this.buildEvidence(inv, surfaces);

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      // Structured output: the model must return exactly this shape, so the
      // result is data rather than prose Shepard would have to interpret.
      output_config: { format: { type: 'json_schema', schema: COMPREHENSION_SCHEMA } },
      system: SYSTEM,
      messages: [{ role: 'user', content: evidence }],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text || text.type !== 'text') {
      throw new Error('model returned no text block');
    }
    const parsed = JSON.parse(text.text) as {
      name: string;
      summary: string;
      actors: { name: string; evidence: string }[];
      systems: { name: string; importance: 'core' | 'supporting' | 'peripheral'; evidence: string }[];
    };

    return {
      name: parsed.name,
      summary: parsed.summary,
      actors: parsed.actors ?? [],
      systems: parsed.systems ?? [],
      available: true,
      producedBy: this.name,
    };
  }

  /**
   * The retrieved context slice.
   *
   * Not the whole repository — the inventory, the enumerated surface, and a
   * small, bounded sample of source from the highest-signal files. Reading
   * files here rather than shipping the model the tree keeps the call cheap and
   * keeps the model's attention on evidence Shepard has already structured.
   */
  private buildEvidence(inv: Inventory, surfaces: DiscoveredSurface[]): string {
    const byKind = (k: string) => surfaces.filter(s => s.kind === k);
    const list = (arr: DiscoveredSurface[], n = 40) =>
      arr.slice(0, n).map(s => `  - ${s.identifier}${s.label ? ` (${s.label})` : ''}`).join('\n')
      || '  (none)';

    const readme = ['README.md', 'readme.md', 'README']
      .map(f => { try { return readFileSync(join(inv.root, f), 'utf8'); } catch { return ''; } })
      .find(Boolean) ?? '';

    return [
      `Frameworks detected: ${inv.frameworks.join(', ') || 'none'}`,
      `Package manager: ${inv.packageManager ?? 'none'}`,
      `File count: ${inv.files.length}`,
      '',
      `Routes (${byKind('route').length}):`, list(byKind('route')),
      '',
      `API endpoints (${byKind('endpoint').length}):`, list(byKind('endpoint')),
      '',
      `Database tables (${byKind('table').length}):`, list(byKind('table')),
      '',
      `Access policies (${byKind('policy').length}):`, list(byKind('policy')),
      '',
      `Integrations (${byKind('integration').length}):`, list(byKind('integration')),
      '',
      readme ? `README (first 4000 chars):\n${readme.slice(0, 4000)}` : 'No README found.',
    ].join('\n');
  }
}

const SYSTEM = `You are the comprehension stage of Shepard, a reliability system that has to
understand an application before it can verify it.

You are given only what Shepard mechanically discovered about a repository: its
frameworks, its routes, endpoints, database tables, access policies and
integrations, and its README if it has one. Your job is to say what this
application is, who uses it, and what its meaningful systems are — well enough
that the person who built it would recognise their own product from your
description without having explained it to you.

Rules that matter:

- Ground every claim in the evidence provided. Do not invent a system, an actor
  or a capability that the routes, tables, policies or README do not support. An
  honest "the evidence does not show this" is worth more than a plausible guess.
- Actors come from access policies and route structure, not from imagination.
- Mark a system "core" only when several surfaces converge on it. Most systems
  are "supporting".
- The summary is two or three sentences a human would recognise, not a list of
  technologies.

Return only the structured object.`;

const COMPREHENSION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'summary', 'actors', 'systems'],
  properties: {
    name: { type: 'string', description: 'A short name for the application' },
    summary: { type: 'string', description: 'Two or three sentences: what this application is and who uses it' },
    actors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'evidence'],
        properties: {
          name: { type: 'string' },
          evidence: { type: 'string', description: 'What in the discovered surface supports this actor' },
        },
      },
    },
    systems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'importance', 'evidence'],
        properties: {
          name: { type: 'string' },
          importance: { type: 'string', enum: ['core', 'supporting', 'peripheral'] },
          evidence: { type: 'string', description: 'What in the discovered surface supports this system' },
        },
      },
    },
  },
} as const;
