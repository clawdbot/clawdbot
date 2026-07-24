import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import JSON5 from "json5";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { parseConfigPathArrayIndex } from "../shared/path-array-index.js";
import { formatCliCommand } from "./command-format.js";
import { formatStrictJsonParseFailure } from "./error-format.js";

export type PathSegment = string;

export type JsonSchemaRecord = {
  type?: unknown;
  properties?: unknown;
  additionalProperties?: unknown;
  items?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  allOf?: unknown;
};

type SetAtPathOptions = {
  numericObjectKeys?: boolean;
  schema?: JsonSchemaRecord;
};

function parseIndexSegment(raw: string): number | undefined {
  return parseConfigPathArrayIndex(raw);
}

function isIndexSegment(raw: string): boolean {
  return parseIndexSegment(raw) !== undefined;
}

function parseBracketPathSegment(raw: string, fullPath: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`Invalid path (empty "[]"): ${fullPath}`);
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    try {
      const parsed = JSON5.parse(trimmed) as unknown;
      if (typeof parsed === "string" && parsed.trim()) {
        return parsed;
      }
    } catch (err) {
      throw new Error(`Invalid path bracket string (${trimmed}): ${fullPath}`, { cause: err });
    }
    throw new Error(`Invalid path bracket string (${trimmed}): ${fullPath}`);
  }
  return trimmed;
}

function assertNotWhitespaceSegment(current: string, raw: string): void {
  if (current.length > 0 && !current.trim()) {
    throw new Error(`Invalid path (empty segment): ${raw}`);
  }
}

function parsePath(raw: string): PathSegment[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const parts: string[] = [];
  let current = "";
  let segmentEmitted = false;
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === "\\") {
      const next = trimmed[i + 1];
      if (next) {
        current += next;
      }
      i += 2;
      continue;
    }
    if (ch === ".") {
      assertNotWhitespaceSegment(current, raw);
      if (!segmentEmitted && !current.trim()) {
        throw new Error(`Invalid path (empty segment): ${raw}`);
      }
      if (current) {
        parts.push(current);
      }
      current = "";
      segmentEmitted = false;
      i += 1;
      continue;
    }
    if (ch === "[") {
      assertNotWhitespaceSegment(current, raw);
      if (!current.trim() && !segmentEmitted && parts.length > 0) {
        throw new Error(`Invalid path (empty segment): ${raw}`);
      }
      if (current) {
        parts.push(current);
      }
      current = "";
      const close = trimmed.indexOf("]", i);
      if (close === -1) {
        throw new Error(`Invalid path (missing "]"): ${raw}`);
      }
      const inside = trimmed.slice(i + 1, close).trim();
      if (!inside) {
        throw new Error(`Invalid path (empty "[]"): ${raw}`);
      }
      parts.push(parseBracketPathSegment(inside, raw));
      const next = trimmed[close + 1];
      if (next !== undefined && next !== "." && next !== "[") {
        throw new Error(`Invalid path (missing separator after bracket): ${raw}`);
      }
      segmentEmitted = true;
      i = close + 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (!segmentEmitted && !current.trim()) {
    throw new Error(`Invalid path (empty segment): ${raw}`);
  }
  if (current) {
    parts.push(current);
  }
  return normalizeStringEntries(parts);
}

export function parseConfigSetPath(path: string): string[] {
  const parsedPath = parsePath(path);
  if (parsedPath.length === 0) {
    throw new Error("Path is empty.");
  }
  validatePathSegments(parsedPath);
  return parsedPath;
}

export function parseConfigSetValue(raw: string, strictJson: boolean): unknown {
  const trimmed = raw.trim();
  if (strictJson) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new Error(formatStrictJsonParseFailure({ value: raw, cause: err }), { cause: err });
    }
  }
  try {
    return JSON5.parse(trimmed);
  } catch {
    return raw;
  }
}

export function validatePathSegments(path: PathSegment[]): void {
  for (const segment of path) {
    if (!isIndexSegment(segment) && isBlockedObjectKey(segment)) {
      throw new Error(`Invalid path segment: ${segment}`);
    }
  }
}

function hasOwnPathKey(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

export function getAtPath(
  root: unknown,
  path: readonly PathSegment[],
): { found: boolean; value?: unknown } {
  let current: unknown = root;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return { found: false };
    }
    if (Array.isArray(current)) {
      const index = parseIndexSegment(segment);
      if (index === undefined || index >= current.length) {
        return { found: false };
      }
      current = current[index];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!hasOwnPathKey(record, segment)) {
      return { found: false };
    }
    current = record[segment];
  }
  return { found: true, value: current };
}

export function formatConfigUnsetMissingPathMessage(params: {
  path: string;
  runtimeOnly: boolean;
}): string {
  if (params.runtimeOnly) {
    return `Config path not found in authored config: ${params.path}. It only exists after runtime defaults are applied, so there is nothing for config unset to remove. Use ${formatCliCommand("openclaw config set <path> <value>")} to override the inherited value.`;
  }
  return `Config path not found: ${params.path}. Nothing was changed. Run ${formatCliCommand("openclaw config get <path>")} first if you are unsure of the path.`;
}

function isSchemaRecord(value: unknown): value is JsonSchemaRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function schemaTypes(schema: JsonSchemaRecord): Set<string> {
  if (typeof schema.type === "string") {
    return new Set([schema.type]);
  }
  if (Array.isArray(schema.type)) {
    return new Set(schema.type.filter((entry): entry is string => typeof entry === "string"));
  }
  return new Set();
}

function schemaAlternatives(
  schema: JsonSchemaRecord,
  seen = new Set<JsonSchemaRecord>(),
): JsonSchemaRecord[] {
  if (seen.has(schema)) {
    return [];
  }
  seen.add(schema);
  const alternatives: JsonSchemaRecord[] = [schema];
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const entries = schema[key];
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (isSchemaRecord(entry)) {
        alternatives.push(...schemaAlternatives(entry, seen));
      }
    }
  }
  return alternatives;
}

function schemaLooksArray(schema: JsonSchemaRecord): boolean {
  return (
    schemaTypes(schema).has("array") || isSchemaRecord(schema.items) || Array.isArray(schema.items)
  );
}

function schemaLooksObject(schema: JsonSchemaRecord): boolean {
  const types = schemaTypes(schema);
  return (
    types.has("object") ||
    isSchemaRecord(schema.properties) ||
    schema.additionalProperties === true ||
    isSchemaRecord(schema.additionalProperties)
  );
}

function propertySchema(schema: JsonSchemaRecord, segment: PathSegment): JsonSchemaRecord[] {
  const schemas: JsonSchemaRecord[] = [];
  for (const alternative of schemaAlternatives(schema)) {
    if (schemaLooksArray(alternative)) {
      const index = parseIndexSegment(segment);
      if (index !== undefined) {
        const indexedItem = Array.isArray(alternative.items)
          ? alternative.items[index]
          : alternative.items;
        if (isSchemaRecord(indexedItem)) {
          schemas.push(indexedItem);
        }
      }
      continue;
    }
    const properties = isSchemaRecord(alternative.properties)
      ? (alternative.properties as Record<string, unknown>)
      : undefined;
    const explicit = properties?.[segment];
    if (isSchemaRecord(explicit)) {
      schemas.push(explicit);
    } else if (isSchemaRecord(alternative.additionalProperties)) {
      schemas.push(alternative.additionalProperties);
    }
  }
  return schemas;
}

function schemasAtPath(
  schema: JsonSchemaRecord | undefined,
  path: readonly PathSegment[],
): JsonSchemaRecord[] {
  if (!schema) {
    return [];
  }
  let schemas = [schema];
  for (const segment of path) {
    schemas = schemas.flatMap((candidate) => propertySchema(candidate, segment));
    if (schemas.length === 0) {
      return [];
    }
  }
  return schemas;
}

function schemaPrefersArrayAtPath(
  schema: JsonSchemaRecord | undefined,
  path: readonly PathSegment[],
): boolean | undefined {
  const candidates = schemasAtPath(schema, path).flatMap((candidate) =>
    schemaAlternatives(candidate),
  );
  if (candidates.length === 0) {
    return undefined;
  }
  const hasArray = candidates.some((candidate) => schemaLooksArray(candidate));
  const hasObject = candidates.some((candidate) => schemaLooksObject(candidate));
  if (hasArray && !hasObject) {
    return true;
  }
  if (hasObject && !hasArray) {
    return false;
  }
  return undefined;
}

function shouldCreateArrayForMissingPathSegment(params: {
  path: readonly PathSegment[];
  segmentIndex: number;
  next?: PathSegment;
  options?: SetAtPathOptions;
}): boolean {
  if (!params.next || params.options?.numericObjectKeys || !isIndexSegment(params.next)) {
    return false;
  }
  const parentPath = params.path.slice(0, params.segmentIndex + 1);
  return schemaPrefersArrayAtPath(params.options?.schema, parentPath) ?? true;
}

export function setAtPath(
  root: Record<string, unknown>,
  path: PathSegment[],
  value: unknown,
  options?: SetAtPathOptions,
): void {
  const last = path.at(-1);
  if (last === undefined) {
    throw new Error("Config path must contain at least one segment");
  }
  let current: unknown = root;
  for (const [i, segment] of path.slice(0, -1).entries()) {
    const nextIsIndex = shouldCreateArrayForMissingPathSegment({
      path,
      segmentIndex: i,
      next: path[i + 1],
      options,
    });
    if (Array.isArray(current)) {
      const index = parseIndexSegment(segment);
      if (index === undefined) {
        throw new Error(`Expected numeric index for array segment "${segment}"`);
      }
      const existing = current[index];
      if (!existing || typeof existing !== "object") {
        current[index] = nextIsIndex ? [] : {};
      }
      current = current[index];
      continue;
    }
    if (!current || typeof current !== "object") {
      throw new Error(`Cannot traverse into "${segment}" (not an object)`);
    }
    const record = current as Record<string, unknown>;
    const existing = hasOwnPathKey(record, segment) ? record[segment] : undefined;
    if (!existing || typeof existing !== "object") {
      record[segment] = nextIsIndex ? [] : {};
    }
    current = record[segment];
  }

  if (Array.isArray(current)) {
    const index = parseIndexSegment(last);
    if (index === undefined) {
      throw new Error(`Expected numeric index for array segment "${last}"`);
    }
    current[index] = value;
    return;
  }
  if (!current || typeof current !== "object") {
    throw new Error(`Cannot set "${last}" (parent is not an object)`);
  }
  (current as Record<string, unknown>)[last] = value;
}

function modelArrayIds(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isPlainRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
      return null;
    }
    ids.add(entry.id.trim());
  }
  return ids;
}

function mergeModelArrays(existing: unknown[], patch: unknown[]): unknown[] {
  const merged = [...existing];
  const indexById = new Map<string, number>();
  for (const [index, entry] of merged.entries()) {
    if (isPlainRecord(entry) && typeof entry.id === "string" && entry.id.trim()) {
      indexById.set(entry.id.trim(), index);
    }
  }
  for (const entry of patch) {
    if (!isPlainRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
      merged.push(entry);
      continue;
    }
    const id = entry.id.trim();
    const existingIndex = indexById.get(id);
    if (existingIndex === undefined) {
      indexById.set(id, merged.length);
      merged.push(entry);
      continue;
    }
    const existingEntry = merged[existingIndex];
    merged[existingIndex] = isPlainRecord(existingEntry) ? { ...existingEntry, ...entry } : entry;
  }
  return merged;
}

function isProviderModelListPath(path: PathSegment[]): boolean {
  return (
    path.length === 4 && path[0] === "models" && path[1] === "providers" && path[3] === "models"
  );
}

function mergeConfigValue(existing: unknown, patch: unknown, path: PathSegment[]): unknown {
  if (isProviderModelListPath(path) && Array.isArray(existing) && Array.isArray(patch)) {
    return mergeModelArrays(existing, patch);
  }
  if (isPlainRecord(existing) && isPlainRecord(patch)) {
    const next: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
      next[key] =
        hasOwnPathKey(next, key) && isPlainRecord(next[key]) && isPlainRecord(value)
          ? mergeConfigValue(next[key], value, [...path, key])
          : value;
    }
    return next;
  }
  throw new Error(`Cannot merge ${toDotPath(path)}; use --replace to replace intentionally.`);
}

export function mergeAtPath(
  root: Record<string, unknown>,
  path: PathSegment[],
  value: unknown,
  options?: SetAtPathOptions,
): void {
  const existing = getAtPath(root, path);
  setAtPath(
    root,
    path,
    existing.found ? mergeConfigValue(existing.value, value, path) : value,
    options,
  );
}

function isProtectedMapReplacementPath(path: PathSegment[]): boolean {
  const joined = path.join(".");
  return (
    joined === "agents.defaults.models" ||
    joined === "models.providers" ||
    (path.length === 3 && path[0] === "models" && path[1] === "providers") ||
    joined === "plugins.entries" ||
    joined === "auth.profiles"
  );
}

function isProtectedArrayReplacementPath(path: PathSegment[]): boolean {
  return isProviderModelListPath(path) || path.join(".") === "agents.list";
}

function formatRemovedEntries(entries: string[]): string {
  const visible = entries.slice(0, 6);
  const suffix =
    entries.length > visible.length ? `, ... ${entries.length - visible.length} more` : "";
  return `${visible.join(", ")}${suffix}`;
}

export function assertNonDestructiveReplacement(params: {
  root: Record<string, unknown>;
  path: PathSegment[];
  value: unknown;
  allowReplace?: boolean;
}): void {
  if (params.allowReplace) {
    return;
  }
  const existing = getAtPath(params.root, params.path);
  if (!existing.found) {
    return;
  }
  const pathLabel = toDotPath(params.path);
  if (isProtectedMapReplacementPath(params.path) && isPlainRecord(existing.value)) {
    if (!isPlainRecord(params.value)) {
      return;
    }
    const nextKeys = new Set(Object.keys(params.value));
    const removed = Object.keys(existing.value).filter((key) => !nextKeys.has(key));
    if (removed.length > 0) {
      throw new Error(
        `Refusing to replace ${pathLabel}; it would remove existing entries: ${formatRemovedEntries(removed)}. Use --merge to merge object values or --replace to replace intentionally.`,
      );
    }
  }
  if (isProtectedArrayReplacementPath(params.path)) {
    const existingIds = modelArrayIds(existing.value);
    const nextIds = modelArrayIds(params.value);
    if (!existingIds || !nextIds) {
      return;
    }
    const removed = [...existingIds].filter((id) => !nextIds.has(id));
    if (removed.length > 0) {
      throw new Error(
        `Refusing to replace ${pathLabel}; it would remove existing entries: ${formatRemovedEntries(removed)}. Use --merge to merge by id or --replace to replace intentionally.`,
      );
    }
  }
}

type UnsetAtPathResult = { removed: true; leafContainer: "array" | "object" } | { removed: false };

export function unsetAtPath(root: Record<string, unknown>, path: PathSegment[]): UnsetAtPathResult {
  const last = path.at(-1);
  if (last === undefined) {
    return { removed: false };
  }
  let current: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (!current || typeof current !== "object") {
      return { removed: false };
    }
    if (Array.isArray(current)) {
      const index = parseIndexSegment(segment);
      if (index === undefined || index >= current.length) {
        return { removed: false };
      }
      current = current[index];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!hasOwnPathKey(record, segment)) {
      return { removed: false };
    }
    current = record[segment];
  }

  if (Array.isArray(current)) {
    const index = parseIndexSegment(last);
    if (index === undefined || index >= current.length) {
      return { removed: false };
    }
    current.splice(index, 1);
    return { removed: true, leafContainer: "array" };
  }
  if (!current || typeof current !== "object") {
    return { removed: false };
  }
  const record = current as Record<string, unknown>;
  if (!hasOwnPathKey(record, last)) {
    return { removed: false };
  }
  delete record[last];
  return { removed: true, leafContainer: "object" };
}

export function toDotPath(path: readonly PathSegment[]): string {
  return path.join(".");
}
