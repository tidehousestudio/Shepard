import { createHash } from 'node:crypto';

/**
 * A finding's identity.
 *
 * Findings must be recognisable across audits so that New, Known, Resolved and
 * Recurrence can be computed instead of guessed. That only works if the
 * fingerprint survives changes that are not the defect: a re-render, a reworded
 * error message, a file that grew by ten lines.
 *
 * So the fingerprint keys on semantic location and failure class only. It never
 * includes line numbers, timestamps, generated ids, or the exact text of an
 * error, all of which move for reasons that have nothing to do with whether the
 * application is broken.
 */
export function fingerprint(parts: {
  class: string;
  surfaceKind: string;
  surfaceIdentifier: string;
  discriminator?: string;
}): string {
  const normalised = [
    parts.class,
    parts.surfaceKind,
    normaliseIdentifier(parts.surfaceIdentifier),
    parts.discriminator ? normaliseIdentifier(parts.discriminator) : '',
  ].join('|');
  return createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

/**
 * Strip the parts of an identifier that vary between runs without the meaning
 * changing: uuids, numeric ids, query strings, ports, timestamps.
 */
export function normaliseIdentifier(s: string): string {
  return s
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ':uuid')
    .replace(/https?:\/\/[^/]+/gi, '')
    .replace(/\?[^#]*/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, ':time')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
