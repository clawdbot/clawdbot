import {
  Document,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Node,
  type Pair,
} from "yaml";
import type { OcPath } from "../oc-path.js";
import {
  formatOcPath,
  isPositionalSeg,
  isQuotedSeg,
  resolvePositionalSeg,
  splitRespectingBrackets,
  unquoteSeg,
} from "../oc-path.js";
import { guardSentinel } from "../sentinel.js";
import type { YamlAst } from "./ast.js";

export type YamlEditResult =
  | { readonly ok: true; readonly ast: YamlAst }
  | {
      readonly ok: false;
      readonly reason: "unresolved" | "no-root" | "parse-error";
    };

export function setYamlOcPath(ast: YamlAst, path: OcPath, newValue: unknown): YamlEditResult {
  if (hasYamlParseErrors(ast)) {
    return { ok: false, reason: "parse-error" };
  }
  if (ast.doc.contents === null) {
    return { ok: false, reason: "no-root" };
  }
  guardYamlSentinel(newValue, formatOcPath(path));

  const rawSegments = pathSegments(path);
  if (rawSegments.length === 0) {
    return { ok: false, reason: "unresolved" };
  }

  const segments = resolvePositionalSegments(ast.doc.contents as Node, rawSegments);
  if (segments === null) {
    return { ok: false, reason: "unresolved" };
  }

  if (!ast.doc.hasIn(segments)) {
    return { ok: false, reason: "unresolved" };
  }

  const { doc: cloned, lineCounter } = cloneDoc(ast.doc);
  cloned.setIn(segments, newValue);
  return { ok: true, ast: { kind: "yaml", raw: cloned.toString(), doc: cloned, lineCounter } };
}

export function insertYamlOcPath(
  ast: YamlAst,
  parentPath: OcPath,
  marker: "+" | { kind: "keyed"; key: string } | { kind: "indexed"; index: number },
  newValue: unknown,
): YamlEditResult {
  if (hasYamlParseErrors(ast)) {
    return { ok: false, reason: "parse-error" };
  }
  if (ast.doc.contents === null) {
    return { ok: false, reason: "no-root" };
  }
  guardYamlSentinel(newValue, `${formatOcPath(parentPath)}/${formatInsertionMarker(marker)}`);

  const rawParentSegments = pathSegments(parentPath);
  const segments =
    rawParentSegments.length === 0
      ? rawParentSegments
      : resolvePositionalSegments(ast.doc.contents as Node, rawParentSegments);
  if (segments === null) {
    return { ok: false, reason: "unresolved" };
  }
  const { doc: cloned, lineCounter } = cloneDoc(ast.doc);

  const parent = segments.length === 0 ? cloned.contents : cloned.getIn(segments, false);
  if (parent === undefined || parent === null) {
    return { ok: false, reason: "unresolved" };
  }

  if (isMap(parent)) {
    if (typeof marker !== "object" || marker.kind !== "keyed") {
      return { ok: false, reason: "unresolved" };
    }
    guardSentinel(marker.key, `${formatOcPath(parentPath)}/${formatInsertionMarker(marker)}`);
    if (cloned.hasIn([...segments, marker.key])) {
      return { ok: false, reason: "unresolved" };
    }
    cloned.setIn([...segments, marker.key], newValue);
    return { ok: true, ast: { kind: "yaml", raw: cloned.toString(), doc: cloned, lineCounter } };
  }

  if (isSeq(parent)) {
    if (typeof marker === "object" && marker.kind === "keyed") {
      return { ok: false, reason: "unresolved" };
    }
    if (marker === "+") {
      cloned.addIn(segments, newValue);
    } else if (typeof marker === "object" && marker.kind === "indexed") {
      const idx = Math.min(marker.index, parent.items.length);
      parent.items.splice(idx, 0, cloned.createNode(newValue) as Node);
    }
    return { ok: true, ast: { kind: "yaml", raw: cloned.toString(), doc: cloned, lineCounter } };
  }

  return { ok: false, reason: "unresolved" };
}

function resolvePositionalSegments(root: Node, segments: readonly string[]): string[] | null {
  const out: string[] = [];
  let node: Node | null = root;
  for (const seg of segments) {
    if (node === null) {
      return null;
    }
    let segNorm = seg;
    if (isPositionalSeg(seg)) {
      const concrete = positionalForYamlNode(node, seg);
      if (concrete === null) {
        return null;
      }
      segNorm = concrete;
    }
    out.push(segNorm);
    if (isMap(node)) {
      const pairs: readonly Pair[] = (node as { items: readonly Pair[] }).items;
      const pair: Pair | undefined = pairs.find((p) => {
        const k = isScalar(p.key) ? p.key.value : p.key;
        return String(k) === segNorm;
      });
      node = (pair?.value as Node | undefined) ?? null;
      continue;
    }
    if (isSeq(node)) {
      const idx = Number(segNorm);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.items.length) {
        return null;
      }
      node = (node.items[idx] as Node | null) ?? null;
      continue;
    }
    node = null;
  }
  return out;
}

function positionalForYamlNode(node: Node, seg: string): string | null {
  if (isMap(node)) {
    const pairs: readonly Pair[] = (node as { items: readonly Pair[] }).items;
    const keys: readonly string[] = pairs.map((p) => String(isScalar(p.key) ? p.key.value : p.key));
    return resolvePositionalSeg(seg, { indexable: false, size: keys.length, keys });
  }
  if (isSeq(node)) {
    const items: readonly Node[] = (node as { items: readonly Node[] }).items;
    return resolvePositionalSeg(seg, { indexable: true, size: items.length });
  }
  return null;
}

function pathSegments(path: OcPath): string[] {
  const segs: string[] = [];
  const collect = (slot: string | undefined) => {
    if (slot === undefined) {
      return;
    }
    for (const sub of splitRespectingBrackets(slot, ".")) {
      segs.push(isQuotedSeg(sub) ? unquoteSeg(sub) : sub);
    }
  };
  collect(path.section);
  collect(path.item);
  collect(path.field);
  return segs;
}

function formatInsertionMarker(
  marker: "+" | { kind: "keyed"; key: string } | { kind: "indexed"; index: number },
): string {
  if (marker === "+") {
    return "+";
  }
  return marker.kind === "keyed" ? `+${marker.key}` : `+${marker.index}`;
}

function guardYamlSentinel(value: unknown, ocPath: string): void {
  guardSentinel(value, ocPath);
  if (Array.isArray(value)) {
    value.forEach((item, index) => guardYamlSentinel(item, `${ocPath}/${index}`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      guardSentinel(key, `${ocPath}/${key}`);
      guardYamlSentinel(child, `${ocPath}/${key}`);
    }
  }
}

function hasYamlParseErrors(ast: YamlAst): boolean {
  return ast.doc.errors.length > 0;
}

function cloneDoc(doc: Document.Parsed): { doc: Document.Parsed; lineCounter: LineCounter } {
  const lineCounter = new LineCounter();
  const cloned = parseDocument(doc.toString(), {
    keepSourceTokens: true,
    prettyErrors: false,
    lineCounter,
  });
  return { doc: cloned, lineCounter };
}
