/**
 * OcPath → AST node resolver.
 *
 * Resolves an `OcPath` against a `MdAst` and returns the matched
 * node (block / item / frontmatter entry / kv field) or `null` if the
 * path doesn't match anything.
 *
 * The address dispatch:
 *
 *   { file }                         → AST root
 *   { file, section }                → AstBlock with matching slug
 *   { file, section, item }          → AstItem inside that block
 *   { file, section, item, field }   → kv.value of that item if kv.key matches
 *
 * The `file` segment is informational here — callers verify file
 * matching before passing the AST. The resolver doesn't load files; it
 * walks an in-memory AST.
 *
 * @module @openclaw/oc-path/resolve
 */

import type { AstBlock, AstItem, FrontmatterEntry, MdAst } from './ast.js';
import type { OcPath } from './oc-path.js';
import { isOrdinalSeg, isPositionalSeg, parseOrdinalSeg, resolvePositionalSeg } from './oc-path.js';

/**
 * The resolved target plus a stable description of what kind of node it
 * is. Lint rules and doctor fixers branch on `kind`.
 */
export type OcPathMatch =
  | { readonly kind: 'root'; readonly node: MdAst }
  | { readonly kind: 'frontmatter'; readonly node: FrontmatterEntry }
  | { readonly kind: 'block'; readonly node: AstBlock }
  | { readonly kind: 'item'; readonly node: AstItem; readonly block: AstBlock }
  | {
      readonly kind: 'item-field';
      readonly node: AstItem;
      readonly block: AstBlock;
      /** The kv.value string, surfaced for convenience. */
      readonly value: string;
    };

/**
 * Resolve an `OcPath` against an AST. Returns the matched node or
 * `null`. Slugs match case-insensitively against `slugify(input)` —
 * "Boundaries" matches a section heading "## Boundaries" because both
 * slugify to "boundaries".
 *
 * Special-case: `OcPath.section === '[frontmatter]'` (literal) addresses
 * frontmatter; `field` then names the frontmatter key. This lets a
 * single OcPath shape address both prose-tree fields and frontmatter
 * fields without growing the tuple.
 */
export function resolveMdOcPath(ast: MdAst, path: OcPath): OcPathMatch | null {
  // Frontmatter addressing: oc://FILE/[frontmatter]/key
  // The frontmatter key sits at the OcPath `item` slot in this 3-segment
  // shape; we accept `field` as a fallback for callers that thread
  // 4-segment paths.
  if (path.section === '[frontmatter]') {
    const key = path.item ?? path.field;
    if (key === undefined) {return null;}
    const entry = ast.frontmatter.find((e) => e.key === key);
    if (entry === undefined) {return null;}
    return { kind: 'frontmatter', node: entry };
  }

  // Plain file root address.
  if (path.section === undefined) {
    return { kind: 'root', node: ast };
  }

  const sectionSlug = path.section.toLowerCase();
  const block = ast.blocks.find((b) => b.slug === sectionSlug);
  if (block === undefined) {return null;}

  // Section-only address.
  if (path.item === undefined) {
    return { kind: 'block', node: block };
  }

  // Item addressing: ordinal (`#N`) > positional (`$first`/`$last`/`-N`)
  // > slug. Ordinal uses absolute document order so two items sharing
  // a slug stay distinguishable.
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
    const itemSlug = path.item.toLowerCase();
    item = block.items.find((i) => i.slug === itemSlug);
  }
  if (item === undefined) {return null;}

  // Item-only address.
  if (path.field === undefined) {
    return { kind: 'item', node: item, block };
  }

  // Item-field address. Requires the item to have a `kv` and the field
  // to match the kv key (case-insensitive). A field on an item without
  // kv shape is unresolvable — return null rather than guessing.
  if (item.kv === undefined) {return null;}
  if (item.kv.key.toLowerCase() !== path.field.toLowerCase()) {return null;}
  return { kind: 'item-field', node: item, block, value: item.kv.value };
}
