import { join, sep } from 'node:path';
import type { SourceIdentity } from '../shared/sources';

export const within = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
export const overlaps = (left: string, right: string): boolean => within(left, right) || within(right, left);

/** Original physical ownership, not today's alias/reconnection. Directory dependencies
 * include descendants: withdrawing a child invalidates a census of its parent. */
export function affectedSource(source: SourceIdentity, roots: string[]): boolean {
  return roots.some(root => within(root, source.folder) || overlaps(root, join(source.folder, source.path)));
}

/** Saved envelopes include citations, censuses, build roots and tool requests.
 * Never search arbitrary prose for path substrings to establish ownership. */
export function associatedMaterial(value: unknown, roots: string[], depth = 0): boolean {
  if (depth > 32) return true; // Uninspectable provenance is conservatively associated, never assumed source-free.
  if (typeof value === 'string' && /^\s*[\[{]/.test(value)) {
    // Pi tool results retain serialized JSON inside text blocks. Decode complete
    // structured envelopes only; do not infer ownership from path-like prose.
    try { return associatedMaterial(JSON.parse(value), roots, depth + 1); } catch { return false; }
  }
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(item => associatedMaterial(item, roots, depth + 1));
  const object = value as Record<string, unknown>;
  if (typeof object.folder === 'string' && typeof object.path === 'string' && roots.some(root => within(root, object.folder as string) || overlaps(root, join(object.folder as string, object.path as string)))) return true;
  if (typeof object.root === 'string' && roots.some(root => overlaps(root, object.root as string))) return true;
  return Object.values(object).some(item => associatedMaterial(item, roots, depth + 1));
}
