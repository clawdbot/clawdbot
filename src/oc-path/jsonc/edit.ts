/**
 * Mutate a `JsoncAst` at an OcPath. Returns a new AST with the value
 * replaced; the original AST is unchanged.
 *
 * **Why immutable**: callers can hold the pre-edit AST for diffing /
 * audit while applying the edit. Plays well with LKG observe (compare
 * pre vs post fingerprints).
 *
 * # Known limitation: trivia loss after edit (tracked as follow-up)
 *
 * `setJsoncOcPath` rebuilds `ast.raw` via `emitJsonc({mode:'render'})`,
 * which RE-SERIALIZES the structural tree. **Comments, blank lines,
 * key-order whitespace, and trailing-comma style are dropped** in the
 * post-edit `raw`. This is the cost of edit-then-emit in the prototype.
 *
 * The byte-fidelity guarantee in this PR applies to the **read path**
 * (`parseJsonc → emitJsonc` round-trip) — that's exercised by the
 * `jsonc-byte-fidelity` scenario test and holds byte-identical for
 * arbitrary input. The **write path** (`parseJsonc → setJsoncOcPath →
 * emitJsonc`) loses trivia.
 *
 * Why we ship as-is: a comment-preserving editor needs the parser to
 * track byte offsets per node, plus splice-aware mutation logic. That
 * is its own lift. The follow-up adds parser offsets and a byte-splice
 * editor; existing callers that need post-edit byte fidelity should
 * patch `raw` directly until then.
 *
 * @module @openclaw/oc-path/jsonc/edit
 */

import type { OcPath } from '../oc-path.js';
import {
  isPositionalSeg,
  isQuotedSeg,
  resolvePositionalSeg,
  splitRespectingBrackets,
  unquoteSeg,
} from '../oc-path.js';
import type { JsoncAst, JsoncEntry, JsoncValue } from './ast.js';
import { emitJsonc } from './emit.js';

export type JsoncEditResult =
  | { readonly ok: true; readonly ast: JsoncAst }
  | { readonly ok: false; readonly reason: 'unresolved' | 'no-root' };

/**
 * Replace the value at `path` with `newValue`. Returns the new AST or
 * a structured failure reason. Numeric segments index into arrays.
 */
export function setJsoncOcPath(
  ast: JsoncAst,
  path: OcPath,
  newValue: JsoncValue,
): JsoncEditResult {
  if (ast.root === null) {return { ok: false, reason: 'no-root' };}

  // Use bracket/brace/quote-aware split so that quoted segments
  // (e.g. `"anthropic/claude-opus-4-7"`) — which can contain dots,
  // slashes, and other punctuation verbatim — survive as one segment.
  // Plain `.split('.')` would shred them and break the round-trip with
  // `resolveJsoncOcPath`, which already respects quoting. Closes the
  // resolve-vs-edit asymmetry flagged on PR #78678.
  const segments: string[] = [];
  if (path.section !== undefined) {segments.push(...splitRespectingBrackets(path.section, '.'));}
  if (path.item !== undefined) {segments.push(...splitRespectingBrackets(path.item, '.'));}
  if (path.field !== undefined) {segments.push(...splitRespectingBrackets(path.field, '.'));}

  // Empty path — replace the root.
  if (segments.length === 0) {
    const next = { ...ast, root: newValue };
    return { ok: true, ast: rebuildRaw(next, path.file) };
  }

  const replaced = replaceAt(ast.root, segments, 0, newValue);
  if (replaced === null) {return { ok: false, reason: 'unresolved' };}
  const next = { ...ast, root: replaced };
  return { ok: true, ast: rebuildRaw(next, path.file) };
}

function replaceAt(
  current: JsoncValue,
  segments: readonly string[],
  i: number,
  newValue: JsoncValue,
): JsoncValue | null {
  const seg = segments[i];
  if (seg === undefined) {return newValue;}
  if (seg.length === 0) {return null;}

  if (current.kind === 'object') {
    // Resolve positional tokens ($first / $last) against the entries
    // ordered key list before any literal-key comparison. Without
    // this, `oc://x.jsonc/agents/$first/alias` would look for a key
    // literally named `$first` and miss the actual first agent.
    // Negative indices (-N) don't apply to keyed containers and
    // resolvePositionalSeg returns null in that case → unresolved.
    let segNorm: string = seg;
    if (isPositionalSeg(seg)) {
      const resolved = resolvePositionalSeg(seg, {
        indexable: false,
        size: current.entries.length,
        keys: current.entries.map((e) => e.key),
      });
      if (resolved === null) {return null;}
      segNorm = resolved;
    }
    // Quoted segments (e.g. `"anthropic/claude-opus-4-7"`) carry the
    // raw bytes verbatim; the entry key in the AST is unquoted, so
    // strip the surrounding quotes before comparing. Bare segments
    // pass through unchanged.
    const lookupKey = isQuotedSeg(segNorm) ? unquoteSeg(segNorm) : segNorm;
    const idx = current.entries.findIndex((e) => e.key === lookupKey);
    if (idx === -1) {return null;}
    const child = current.entries[idx];
    if (child === undefined) {return null;}
    const replacedChild = replaceAt(child.value, segments, i + 1, newValue);
    if (replacedChild === null) {return null;}
    const newEntry: JsoncEntry = { ...child, value: replacedChild };
    const newEntries = current.entries.slice();
    newEntries[idx] = newEntry;
    return {
      kind: 'object',
      entries: newEntries,
      ...(current.line !== undefined ? { line: current.line } : {}),
    };
  }

  if (current.kind === 'array') {
    // Resolve positional tokens ($first / $last / -N) against the
    // array's size before the numeric coercion below; without this
    // `Number('$last')` is NaN and the path silently unresolves.
    let segNorm: string = seg;
    if (isPositionalSeg(seg)) {
      const resolved = resolvePositionalSeg(seg, {
        indexable: true,
        size: current.items.length,
      });
      if (resolved === null) {return null;}
      segNorm = resolved;
    }
    const idx = Number(segNorm);
    if (!Number.isInteger(idx) || idx < 0 || idx >= current.items.length) {return null;}
    const child = current.items[idx];
    if (child === undefined) {return null;}
    const replacedChild = replaceAt(child, segments, i + 1, newValue);
    if (replacedChild === null) {return null;}
    const newItems = current.items.slice();
    newItems[idx] = replacedChild;
    return {
      kind: 'array',
      items: newItems,
      ...(current.line !== undefined ? { line: current.line } : {}),
    };
  }

  // Primitive — can't descend.
  return null;
}

/**
 * Re-render `ast.raw` from the (possibly mutated) tree.
 *
 * **Trivia is dropped** — see the module-level "Known limitation"
 * section above. Subsequent `emitJsonc(returnedAst)` returns these
 * synthesized bytes, NOT the original byte-fidelity input.
 *
 * Production-quality fix: parser tracks byte offsets per node;
 * `setJsoncOcPath` does a `raw.slice(0,start) + newBytes + raw.slice(end)`
 * splice, leaving trivia untouched. Tracked as PR follow-up.
 */
function rebuildRaw(ast: JsoncAst, fileName?: string): JsoncAst {
  // Plumb fileName so render-mode emit's sentinel guard reports the
  // file context (`oc://gateway.jsonc/[path]`) instead of the empty
  // fallback (`oc:///[path]`). The throw originates here when a
  // caller-injected sentinel reaches a leaf — without the file
  // context, forensics + audit pipelines see "rejected somewhere"
  // with no way to identify the file.
  const opts = fileName !== undefined
    ? { mode: 'render' as const, fileNameForGuard: fileName }
    : { mode: 'render' as const };
  const next: JsoncAst = { kind: 'jsonc', raw: '', root: ast.root };
  const rendered = emitJsonc(next, opts);
  return { ...ast, raw: rendered };
}
