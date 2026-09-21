import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { KnowledgeStore } from '../knowledge/store.js';

/**
 * Content-addressed evidence.
 *
 * Findings are only as good as what backs them, and evidence outlives the
 * conversation that produced it. Blobs are stored by hash so that re-observing
 * the same screenshot or log across many audits costs nothing and so that a
 * finding's evidence cannot be silently rewritten underneath it.
 */
export class EvidenceStore {
  constructor(private readonly root: string, private readonly knowledge: KnowledgeStore) {
    mkdirSync(root, { recursive: true });
  }

  put(appId: string, kind: string, content: Buffer | string, meta?: unknown): string {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const hash = createHash('sha256').update(buf).digest('hex');
    const dir = join(this.root, hash.slice(0, 2));
    const path = join(dir, hash.slice(2));
    if (!existsSync(path)) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, buf);
    }
    this.knowledge.registerEvidence(appId, { content: buf, kind, path, meta });
    return hash;
  }
}
