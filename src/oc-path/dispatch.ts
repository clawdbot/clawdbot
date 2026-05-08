/**
 * Cross-kind utilities. The substrate exposes per-kind verbs only;
 * `inferKind` is a convention helper for callers who want to map
 * filename → kind so they can pick the right `parseXxx` / `setXxx` /
 * `resolveXxx` function.
 *
 * Earlier drafts had `resolveOcPath` / `setOcPath` / `appendOcPath`
 * universal dispatchers with tagged-union AST inputs. They were dropped
 * — the kind tag bled through every consumer (lint runner, doctor
 * fixers, tests) since those code paths still needed to know the kind
 * to use the result. Per-kind verbs are honest about input/output.
 *
 * @module @openclaw/oc-path/dispatch
 */

export type OcKind = 'md' | 'jsonc' | 'jsonl' | 'yaml';

/**
 * Recommend a kind from a filename. Pure convention helper — returns
 * the substrate's default mapping. Consumers can override.
 */
export function inferKind(filename: string): OcKind | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.md')) {return 'md';}
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) {return 'jsonl';}
  if (lower.endsWith('.jsonc') || lower.endsWith('.json')) {return 'jsonc';}
  if (lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.lobster')) {
    return 'yaml';
  }
  return null;
}
