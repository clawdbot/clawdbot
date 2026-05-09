/**
 * OcPath → MdAst node. Walks an in-memory AST; the file slot is
 * informational (callers verify file matching upstream).
 *
 *   { file }                         → root
 *   { file, section }                → block
 *   { file, section, item }          → item
 *   { file, section, item, field }   → kv.value
 *
 * @module @openclaw/oc-path/resolve
 */

import type { AstBlock, AstItem, FrontmatterEntry, MdAst } from "./ast.js";
import type { OcPath } from "./oc-path.js";
import { isOrdinalSeg, isPositionalSeg, parseOrdinalSeg, resolvePositionalSeg } from "./oc-path.js";

export type OcPathMatch =
  | { readonly kind: "root"; readonly node: MdAst }
  | { readonly kind: "frontmatter"; readonly node: FrontmatterEntry }
  | { readonly kind: "block"; readonly node: AstBlock }
  | { readonly kind: "item"; readonly node: AstItem; readonly block: AstBlock }
  | {
      readonly kind: "item-field";
      readonly node: AstItem;
      readonly block: AstBlock;
      /** The kv.value string, surfaced for convenience. */
      readonly value: string;
    };

/**
 * Resolve. Slugs match case-insensitively. `[frontmatter]` is a
 * literal section sentinel; the frontmatter key sits at `item` (or
 * `field` for 4-segment callers).
 */
export function resolveMdOcPath(ast: MdAst, path: OcPath): OcPathMatch | null {
  if (path.section === "[frontmatter]") {
    const key = path.item ?? path.field;
    if (key === undefined) {return null;}
    const entry = ast.frontmatter.find((e) => e.key === key);
    if (entry === undefined) {return null;}
    return { kind: "frontmatter", node: entry };
  }

  if (path.section === undefined) {return { kind: "root", node: ast };}

  const block = ast.blocks.find((b) => b.slug === path.section!.toLowerCase());
  if (block === undefined) {return null;}
  if (path.item === undefined) {return { kind: "block", node: block };}

  // Item dispatch: ordinal (#N) > positional ($last) > slug.
  // Ordinal uses document order so duplicate-slug items stay distinct.
  let item: AstItem | undefined;
  if (isOrdinalSeg(path.item)) {
    const n = parseOrdinalSeg(path.item);
    if (n === null || n < 0 || n >= block.items.length) {return null;}
    item = block.items[n];
  } else if (isPositionalSeg(path.item)) {
    const concrete = resolvePositionalSeg(path.item, {
      indexable: true,
      size: block.items.length,
    });
    if (concrete === null) {return null;}
    item = block.items[Number(concrete)];
  } else {
    item = block.items.find((i) => i.slug === path.item!.toLowerCase());
  }
  if (item === undefined) {return null;}
  if (path.field === undefined) {return { kind: "item", node: item, block };}

  if (item.kv === undefined) {return null;}
  if (item.kv.key.toLowerCase() !== path.field.toLowerCase()) {return null;}
  return { kind: "item-field", node: item, block, value: item.kv.value };
}
