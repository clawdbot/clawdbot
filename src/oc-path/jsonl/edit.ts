/**
 * Mutate a `JsonlAst` at an OcPath. Returns a new AST with the line
 * (or sub-field of a line) replaced.
 *
 * Edit shapes:
 *
 *   oc://session-events/L42                    → replace line 42's whole value
 *   oc://session-events/L42/field              → replace field on line 42
 *   oc://session-events/L42/field.sub          → dotted descent
 *   oc://session-events/$last/...              → resolves to most recent value
 *
 * Append (no existing line) is NOT a `set` — use `appendJsonlLine` for
 * that. `setJsonlOcPath` only edits existing addresses.
 *
 * @module @openclaw/oc-path/jsonl/edit
 */

import type { OcPath } from '../oc-path.js';
import {
  isPositionalSeg,
  isQuotedSeg,
  resolvePositionalSeg,
  splitRespectingBrackets,
  unquoteSeg,
} from '../oc-path.js';
import type { JsoncEntry, JsoncValue } from '../jsonc/ast.js';
import type { JsonlAst, JsonlLine } from './ast.js';
import { emitJsonl } from './emit.js';

export type JsonlEditResult =
  | { readonly ok: true; readonly ast: JsonlAst }
  | { readonly ok: false; readonly reason: 'unresolved' | 'not-a-value-line' };

export function setJsonlOcPath(
  ast: JsonlAst,
  path: OcPath,
  newValue: JsoncValue,
): JsonlEditResult {
  const head = path.section;
  if (head === undefined) {return { ok: false, reason: 'unresolved' };}

  const lineIdx = pickLineIndex(ast, head);
  if (lineIdx === -1) {return { ok: false, reason: 'unresolved' };}
  const target = ast.lines[lineIdx];
  if (target === undefined) {return { ok: false, reason: 'unresolved' };}

  // No item/field — replace the whole line value. Requires the line to
  // already be a value line (we don't synthesize lines from blanks).
  if (path.item === undefined && path.field === undefined) {
    if (target.kind !== 'value') {return { ok: false, reason: 'not-a-value-line' };}
    const newLine: JsonlLine = {
      kind: 'value',
      line: target.line,
      value: newValue,
      raw: target.raw,
    };
    return finalize(ast, lineIdx, newLine, path.file);
  }

  if (target.kind !== 'value') {return { ok: false, reason: 'not-a-value-line' };}

  // Bracket/brace/quote-aware split — preserves quoted segments
  // verbatim so the edit path matches `resolveJsonlOcPath`'s
  // unquoting behavior. Plain `.split('.')` would shred a quoted key
  // and silently desync read-vs-write.
  const segments: string[] = [];
  if (path.item !== undefined) {segments.push(...splitRespectingBrackets(path.item, '.'));}
  if (path.field !== undefined) {segments.push(...splitRespectingBrackets(path.field, '.'));}

  const replaced = replaceAt(target.value, segments, 0, newValue);
  if (replaced === null) {return { ok: false, reason: 'unresolved' };}
  const newLine: JsonlLine = {
    kind: 'value',
    line: target.line,
    value: replaced,
    raw: target.raw,
  };
  return finalize(ast, lineIdx, newLine, path.file);
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
    // Resolve positional tokens ($first / $last) against the entries'
    // ordered key list before any literal-key comparison. Keeps the
    // jsonl edit path symmetric with resolveJsonlOcPath, which already
    // honors positional tokens during read.
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
    // Quoted segments carry the raw bytes verbatim; AST entry keys
    // are unquoted. Strip the surrounding quotes before comparing.
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

  return null;
}

function pickLineIndex(ast: JsonlAst, addr: string): number {
  // Mirrors the line-address grammar handled by resolveJsonlOcPath's
  // pickLine and find.ts's pickLine — the four shapes a JSONL line can
  // be addressed by. Without `$first` and `-N` here, a path that
  // resolves cleanly under those tokens would silently unresolve on
  // the edit path (resolve↔write asymmetry).
  if (addr === '$last') {
    for (let i = ast.lines.length - 1; i >= 0; i--) {
      const l = ast.lines[i];
      if (l !== undefined && l.kind === 'value') {return i;}
    }
    return -1;
  }
  if (addr === '$first') {
    for (let i = 0; i < ast.lines.length; i++) {
      const l = ast.lines[i];
      if (l !== undefined && l.kind === 'value') {return i;}
    }
    return -1;
  }
  if (/^-\d+$/.test(addr)) {
    // -N selects the Nth-from-last value line. Walk only value lines
    // so blank/malformed lines don't shift the count (consistent with
    // resolve.ts's pickLine).
    const valueIndices: number[] = [];
    for (let i = 0; i < ast.lines.length; i++) {
      const l = ast.lines[i];
      if (l !== undefined && l.kind === 'value') {valueIndices.push(i);}
    }
    const n = valueIndices.length + Number(addr);
    return n >= 0 && n < valueIndices.length ? (valueIndices[n] ?? -1) : -1;
  }
  const m = /^L(\d+)$/.exec(addr);
  if (m === null || m[1] === undefined) {return -1;}
  const target = Number(m[1]);
  return ast.lines.findIndex((l) => l.line === target);
}

function finalize(ast: JsonlAst, lineIdx: number, newLine: JsonlLine, fileName?: string): JsonlEditResult {
  const newLines = ast.lines.slice();
  newLines[lineIdx] = newLine;
  const next: JsonlAst = {
    kind: 'jsonl',
    raw: '',
    lines: newLines,
    ...(ast.lineEnding !== undefined ? { lineEnding: ast.lineEnding } : {}),
  };
  const opts = fileName !== undefined
    ? { mode: 'render' as const, fileNameForGuard: fileName }
    : { mode: 'render' as const };
  const rendered = emitJsonl(next, opts);
  return { ok: true, ast: { ...next, raw: rendered } };
}

/**
 * Append a new value as the next line. Useful for session checkpointing
 * (each event is a new line). Returns a new AST. The `path` parameter
 * is accepted for OcPath-naming consistency but jsonl append addresses
 * the file as a whole (line numbers are assigned by the substrate).
 */
export function appendJsonlOcPath(ast: JsonlAst, value: JsoncValue): JsonlAst {
  const nextLineNo =
    ast.lines.length === 0 ? 1 : (ast.lines[ast.lines.length - 1]?.line ?? 0) + 1;
  const newLine: JsonlLine = {
    kind: 'value',
    line: nextLineNo,
    value,
    raw: '',
  };
  const next: JsonlAst = { kind: 'jsonl', raw: '', lines: [...ast.lines, newLine] };
  const rendered = emitJsonl(next, { mode: 'render' });
  return { ...next, raw: rendered };
}
