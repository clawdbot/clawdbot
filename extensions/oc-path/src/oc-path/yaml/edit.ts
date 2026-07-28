// OC Path module implements edit behavior.
import { Document, isMap, isSeq, LineCounter, parseDocument, type Node } from "yaml";
import type { OcPath } from "../oc-path.js";
import { formatOcPath } from "../oc-path.js";
import { guardSentinel } from "../sentinel.js";
import type { YamlAst } from "./ast.js";
import { resolveYamlOcPath } from "./resolve.js";

type YamlEditResult =
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

  // Keep read/write addressing aligned for positional tokens and YAML key coercion.
  const match = resolveYamlOcPath(ast, path);
  if (match === null || match.kind === "root") {
    return { ok: false, reason: "unresolved" };
  }
  const segments = match.path;
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

  const match = resolveYamlOcPath(ast, parentPath);
  if (match === null) {
    return { ok: false, reason: "unresolved" };
  }
  const segments = match.kind === "root" ? [] : match.path;
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
