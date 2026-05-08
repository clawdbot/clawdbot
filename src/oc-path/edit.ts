/**
 * Mutate a `MdAst` at an OcPath. Returns a new AST with the
 * value replaced; the original is unchanged.
 *
 * Writable surface:
 *
 *   oc://FILE/[frontmatter]/key   → frontmatter entry value
 *   oc://FILE/section/item/field  → item.kv.value (when item has kv shape)
 *
 * Section bodies, tables, and code blocks are NOT writable through
 * this primitive — they're prose, and a generic "set" doesn't compose
 * cleanly. Doctor fixers handle structural edits via dedicated verbs.
 *
 * @module @openclaw/oc-path/edit
 */

import type { AstBlock, AstItem, FrontmatterEntry, MdAst } from './ast.js';
import type { OcPath } from './oc-path.js';

export type MdEditResult =
  | { readonly ok: true; readonly ast: MdAst }
  | {
      readonly ok: false;
      readonly reason: 'unresolved' | 'not-writable' | 'no-item-kv';
    };

/**
 * Replace the value at `path` with `newValue`. The new AST has fresh
 * `raw` re-rendered from the structural fields.
 */
export function setMdOcPath(
  ast: MdAst,
  path: OcPath,
  newValue: string,
): MdEditResult {
  // Frontmatter address: oc://FILE/[frontmatter]/<key>
  if (path.section === '[frontmatter]') {
    const key = path.item ?? path.field;
    if (key === undefined) {return { ok: false, reason: 'unresolved' };}
    const idx = ast.frontmatter.findIndex((e) => e.key === key);
    if (idx === -1) {return { ok: false, reason: 'unresolved' };}
    const existing = ast.frontmatter[idx];
    if (existing === undefined) {return { ok: false, reason: 'unresolved' };}
    const newEntry: FrontmatterEntry = { ...existing, value: newValue };
    const newFm = ast.frontmatter.slice();
    newFm[idx] = newEntry;
    return finalize({ ...ast, frontmatter: newFm });
  }

  // Item-field address: oc://FILE/section/item/field
  if (
    path.section === undefined ||
    path.item === undefined ||
    path.field === undefined
  ) {
    return { ok: false, reason: 'not-writable' };
  }

  const sectionSlug = path.section.toLowerCase();
  const blockIdx = ast.blocks.findIndex((b) => b.slug === sectionSlug);
  if (blockIdx === -1) {return { ok: false, reason: 'unresolved' };}
  const block = ast.blocks[blockIdx];
  if (block === undefined) {return { ok: false, reason: 'unresolved' };}

  const itemSlug = path.item.toLowerCase();
  const itemIdx = block.items.findIndex((i) => i.slug === itemSlug);
  if (itemIdx === -1) {return { ok: false, reason: 'unresolved' };}
  const item = block.items[itemIdx];
  if (item === undefined) {return { ok: false, reason: 'unresolved' };}
  if (item.kv === undefined) {return { ok: false, reason: 'no-item-kv' };}
  if (item.kv.key.toLowerCase() !== path.field.toLowerCase()) {
    return { ok: false, reason: 'unresolved' };
  }

  const newItem: AstItem = {
    ...item,
    kv: { key: item.kv.key, value: newValue },
  };
  const newItems = block.items.slice();
  newItems[itemIdx] = newItem;
  const newBlock: AstBlock = {
    ...block,
    items: newItems,
    bodyText: rebuildBlockBody(block, newItems),
  };
  const newBlocks = ast.blocks.slice();
  newBlocks[blockIdx] = newBlock;
  return finalize({ ...ast, blocks: newBlocks });
}

/**
 * Rebuild block.bodyText so emit-roundtrip mode reflects the edit. We
 * do a minimal in-place substitution on the existing bodyText: find
 * each `- key: value` line for a touched item and rewrite the value.
 *
 * For items without a matching bullet line, we leave bodyText alone
 * (the structural fields take precedence in render mode anyway).
 */
function rebuildBlockBody(block: AstBlock, newItems: readonly AstItem[]): string {
  let body = block.bodyText;
  for (let i = 0; i < newItems.length; i++) {
    const newItem = newItems[i];
    const oldItem = block.items[i];
    if (newItem === undefined || oldItem === undefined) {continue;}
    if (newItem.kv === undefined || oldItem.kv === undefined) {continue;}
    if (newItem.kv.value === oldItem.kv.value) {continue;}
    const re = new RegExp(
      `^(\\s*-\\s*${escapeRegex(oldItem.kv.key)}\\s*:\\s*).*$`,
      'm',
    );
    body = body.replace(re, `$1${newItem.kv.value}`);
  }
  return body;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Re-render `ast.raw` from the (possibly mutated) tree using the same
 * shape the round-trip emitter expects.
 */
function finalize(ast: MdAst): MdEditResult {
  const parts: string[] = [];
  if (ast.frontmatter.length > 0) {
    parts.push('---');
    for (const fm of ast.frontmatter) {
      parts.push(`${fm.key}: ${formatFrontmatterValue(fm.value)}`);
    }
    parts.push('---');
  }
  if (ast.preamble.length > 0) {
    if (parts.length > 0) {parts.push('');}
    parts.push(ast.preamble);
  }
  for (const block of ast.blocks) {
    if (parts.length > 0) {parts.push('');}
    parts.push(`## ${block.heading}`);
    if (block.bodyText.length > 0) {parts.push(block.bodyText);}
  }
  const raw = parts.join('\n');
  return { ok: true, ast: { ...ast, raw } };
}

function formatFrontmatterValue(value: string): string {
  if (value.length === 0) {return '""';}
  if (/[:#&*?|<>=!%@`,[\]{}\r\n]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

