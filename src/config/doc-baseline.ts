import { createHash } from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import type { ConfigSchemaResponse } from "./schema.js";
import { schemaHasChildren } from "./schema.shared.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JsonSchemaNode = Record<string, unknown>;

type JsonSchemaObject = JsonSchemaNode & {
  type?: string | string[];
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: JsonSchemaObject | boolean;
  items?: JsonSchemaObject | JsonSchemaObject[];
  enum?: unknown[];
  default?: unknown;
  deprecated?: boolean;
  anyOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
};

type ConfigDocBaselineKind = "core" | "channel" | "plugin";

export type ConfigDocBaselineEntry = {
  path: string;
  kind: ConfigDocBaselineKind;
  type?: string | string[];
  required: boolean;
  enumValues?: JsonValue[];
  defaultValue?: JsonValue;
  deprecated: boolean;
  sensitive: boolean;
  tags: string[];
  label?: string;
  help?: string;
  hasChildren: boolean;
};

type ConfigDocBaseline = {
  generatedBy: "scripts/generate-config-doc-baseline.ts";
  coreEntries: ConfigDocBaselineEntry[];
  channelEntries: ConfigDocBaselineEntry[];
  pluginEntries: ConfigDocBaselineEntry[];
};

type ConfigDocBaselineKindBaseline = {
  generatedBy: "scripts/generate-config-doc-baseline.ts";
  kind: ConfigDocBaselineKind;
  entries: ConfigDocBaselineEntry[];
};

type ConfigDocBaselineArtifacts = {
  combined: string;
  core: string;
  channel: string;
  plugin: string;
};

type ConfigDocBaselineArtifactsRender = {
  baseline: ConfigDocBaseline;
  json: ConfigDocBaselineArtifacts;
};

type ConfigDocBaselineArtifactPaths = {
  combined: string;
  core: string;
  channel: string;
  plugin: string;
};

type ConfigDocBaselineArtifactsWriteResult = {
  changed: boolean;
  wrote: boolean;
  jsonPaths: ConfigDocBaselineArtifactPaths;
  hashPath: string;
};

const GENERATED_BY = "scripts/generate-config-doc-baseline.ts" as const;
const DEFAULT_COMBINED_OUTPUT = "docs/.generated/config-baseline.json";
const DEFAULT_CORE_OUTPUT = "docs/.generated/config-baseline.core.json";
const DEFAULT_CHANNEL_OUTPUT = "docs/.generated/config-baseline.channel.json";
const DEFAULT_PLUGIN_OUTPUT = "docs/.generated/config-baseline.plugin.json";
const DEFAULT_HASH_OUTPUT = "docs/.generated/config-baseline.sha256";
let cachedConfigDocBaselinePromise: Promise<ConfigDocBaseline> | null = null;
let cachedDocBaselineRuntimePromise: Promise<typeof import("./doc-baseline.runtime.js")> | null =
  null;
const uiHintIndexCache = new WeakMap<
  ConfigSchemaResponse["uiHints"],
  Map<
    number,
    Array<{ path: string; parts: string[]; hint: ConfigSchemaResponse["uiHints"][string] }>
  >
>();
const schemaHasChildrenCache = new WeakMap<JsonSchemaObject, boolean>();

function logConfigDocBaselineDebug(message: string): void {
  if (process.env.OPENCLAW_CONFIG_DOC_BASELINE_DEBUG === "1") {
    console.error(`[config-doc-baseline] ${message}`);
  }
}

function resolveRepoRoot(): string {
  const fromPackage = resolveOpenClawPackageRootSync({
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    moduleUrl: import.meta.url,
  });
  if (fromPackage) {
    return fromPackage;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

async function loadDocBaselineRuntime() {
  cachedDocBaselineRuntimePromise ??= import("./doc-baseline.runtime.js");
  return await cachedDocBaselineRuntimePromise;
}

function normalizeBaselinePath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/\[\]/g, ".*")
    .replace(/\[(\*|\d+)\]/g, ".*")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.+/g, ".");
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => normalizeJsonValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
    return normalized;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => {
      const normalized = normalizeJsonValue(entry);
      return normalized === undefined ? null : ([key, normalized] as const);
    })
    .filter((entry): entry is readonly [string, JsonValue] => entry !== null);

  return Object.fromEntries(entries);
}

function normalizeEnumValues(values: unknown[] | undefined): JsonValue[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values
    .map((entry) => normalizeJsonValue(entry))
    .filter((entry): entry is JsonValue => entry !== undefined);
  return normalized.length > 0 ? normalized : undefined;
}

function asSchemaObject(value: unknown): JsonSchemaObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchemaObject;
}

function splitHintLookupPath(path: string): string[] {
  const normalized = normalizeBaselinePath(path);
  return normalized ? normalized.split(".").filter(Boolean) : [];
}

function resolveUiHintMatch(
  uiHints: ConfigSchemaResponse["uiHints"],
  path: string,
): ConfigSchemaResponse["uiHints"][string] | undefined {
  const targetParts = splitHintLookupPath(path);
  if (targetParts.length === 0) {
    return undefined;
  }

  let index = uiHintIndexCache.get(uiHints);
  if (!index) {
    index = new Map();
    for (const [hintPath, hint] of Object.entries(uiHints)) {
      const parts = splitHintLookupPath(hintPath);
      const bucket = index.get(parts.length);
      const entry = { path: hintPath, parts, hint };
      if (bucket) {
        bucket.push(entry);
      } else {
        index.set(parts.length, [entry]);
      }
    }
    uiHintIndexCache.set(uiHints, index);
  }

  const candidates = index.get(targetParts.length);
  if (!candidates) {
    return undefined;
  }

  let bestMatch:
    | {
        hint: ConfigSchemaResponse["uiHints"][string];
        wildcardCount: number;
      }
    | undefined;

  for (const candidate of candidates) {
    let wildcardCount = 0;
    let matches = true;
    for (let index = 0; index < candidate.parts.length; index += 1) {
      const hintPart = candidate.parts[index];
      const targetPart = targetParts[index];
      if (hintPart === targetPart) {
        continue;
      }
      if (hintPart === "*") {
        wildcardCount += 1;
        continue;
      }
      matches = false;
      break;
    }
    if (!matches) {
      continue;
    }
    if (!bestMatch || wildcardCount < bestMatch.wildcardCount) {
      bestMatch = { hint: candidate.hint, wildcardCount };
      if (wildcardCount === 0) {
        break;
      }
    }
  }

  return bestMatch?.hint;
}

function resolveSchemaHasChildren(schema: JsonSchemaObject): boolean {
  const cached = schemaHasChildrenCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const next = schemaHasChildren(schema);
  schemaHasChildrenCache.set(schema, next);
  return next;
}

function normalizeTypeValue(value: string | string[] | undefined): string | string[] | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const normalized = [...new Set(value)].toSorted((left, right) => left.localeCompare(right));
    return normalized.length === 1 ? normalized[0] : normalized;
  }
  return value;
}

function mergeTypeValues(
  left: string | string[] | undefined,
  right: string | string[] | undefined,
): string | string[] | undefined {
  const merged = new Set<string>();
  for (const value of [left, right]) {
    if (!value) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        merged.add(entry);
      }
      continue;
    }
    merged.add(value);
  }
  return normalizeTypeValue([...merged]);
}

function areJsonValuesEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mergeJsonValueArrays(
  left: JsonValue[] | undefined,
  right: JsonValue[] | undefined,
): JsonValue[] | undefined {
  if (!left?.length) {
    return right ? [...right] : undefined;
  }
  if (!right?.length) {
    return [...left];
  }

  const merged = new Map<string, JsonValue>();
  for (const value of [...left, ...right]) {
    merged.set(JSON.stringify(value), value);
  }
  return [...merged.entries()]
    .toSorted(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([, value]) => value);
}

function mergeConfigDocBaselineEntry(
  current: ConfigDocBaselineEntry,
  next: ConfigDocBaselineEntry,
): ConfigDocBaselineEntry {
  const label = current.label === next.label ? current.label : (current.label ?? next.label);
  const help = current.help === next.help ? current.help : (current.help ?? next.help);
  const defaultValue = areJsonValuesEqual(current.defaultValue, next.defaultValue)
    ? (current.defaultValue ?? next.defaultValue)
    : undefined;

  return {
    path: current.path,
    kind: current.kind,
    type: mergeTypeValues(current.type, next.type),
    required: current.required && next.required,
    enumValues: mergeJsonValueArrays(current.enumValues, next.enumValues),
    defaultValue,
    deprecated: current.deprecated || next.deprecated,
    sensitive: current.sensitive || next.sensitive,
    tags: [...new Set([...current.tags, ...next.tags])].toSorted((left, right) =>
      left.localeCompare(right),
    ),
    label,
    help,
    hasChildren: current.hasChildren || next.hasChildren,
  };
}

function resolveEntryKind(configPath: string): ConfigDocBaselineKind {
  if (configPath.startsWith("channels.")) {
    return "channel";
  }
  if (configPath.startsWith("plugins.entries.")) {
    return "plugin";
  }
  return "core";
}

async function loadBundledConfigSchemaResponse(): Promise<ConfigSchemaResponse> {
  const repoRoot = resolveRepoRoot();
  const runtime = await loadDocBaselineRuntime();
  const env = {
    ...process.env,
    HOME: os.tmpdir(),
    OPENCLAW_STATE_DIR: path.join(os.tmpdir(), "openclaw-config-doc-baseline-state"),
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "extensions"),
  };

  const manifestRegistry = runtime.loadPluginManifestRegistry({
    env,
    config: {},
    bundledChannelConfigCollector: runtime.collectBundledChannelConfigs,
  });
  logConfigDocBaselineDebug(`loaded ${manifestRegistry.plugins.length} bundled plugin manifests`);
  const bundledRegistry = {
    ...manifestRegistry,
    plugins: manifestRegistry.plugins.filter((plugin) => plugin.origin === "bundled"),
  };
  const channelPlugins = runtime.collectChannelSchemaMetadata(bundledRegistry);
  logConfigDocBaselineDebug(
    `loaded ${channelPlugins.length} bundled channel entries from metadata`,
  );

  return runtime.buildConfigSchema({
    plugins: runtime.collectPluginSchemaMetadata(bundledRegistry),
    channels: channelPlugins,
  });
}

export function collectConfigDocBaselineEntries(
  schema: JsonSchemaObject,
  uiHints: ConfigSchemaResponse["uiHints"],
  pathPrefix = "",
  required = false,
  entries: ConfigDocBaselineEntry[] = [],
  visited = new WeakMap<JsonSchemaObject, Set<string>>(),
): ConfigDocBaselineEntry[] {
  const normalizedPath = normalizeBaselinePath(pathPrefix);
  const visitKey = `${normalizedPath}|${required ? "1" : "0"}`;
  const visitedPaths = visited.get(schema);
  if (visitedPaths?.has(visitKey)) {
    return entries;
  }
  if (visitedPaths) {
    visitedPaths.add(visitKey);
  } else {
    visited.set(schema, new Set([visitKey]));
  }

  if (normalizedPath) {
    const hint = resolveUiHintMatch(uiHints, normalizedPath);
    entries.push({
      path: normalizedPath,
      kind: resolveEntryKind(normalizedPath),
      type: normalizeTypeValue(schema.type),
      required,
      enumValues: normalizeEnumValues(schema.enum),
      defaultValue: normalizeJsonValue(schema.default),
      deprecated: schema.deprecated === true,
      sensitive: hint?.sensitive === true,
      tags: [...(hint?.tags ?? [])].toSorted((left, right) => left.localeCompare(right)),
      label: hint?.label,
      help: hint?.help,
      hasChildren: resolveSchemaHasChildren(schema),
    });
  }

  const requiredKeys = new Set(schema.required ?? []);
  for (const key of Object.keys(schema.properties ?? {}).toSorted((left, right) =>
    left.localeCompare(right),
  )) {
    const child = asSchemaObject(schema.properties?.[key]);
    if (!child) {
      continue;
    }
    const childPath = normalizedPath ? `${normalizedPath}.${key}` : key;
    collectConfigDocBaselineEntries(
      child,
      uiHints,
      childPath,
      requiredKeys.has(key),
      entries,
      visited,
    );
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    const wildcard = asSchemaObject(schema.additionalProperties);
    if (wildcard) {
      const wildcardPath = normalizedPath ? `${normalizedPath}.*` : "*";
      collectConfigDocBaselineEntries(wildcard, uiHints, wildcardPath, false, entries, visited);
    }
  }

  if (Array.isArray(schema.items)) {
    for (const item of schema.items) {
      const child = asSchemaObject(item);
      if (!child) {
        continue;
      }
      const itemPath = normalizedPath ? `${normalizedPath}.*` : "*";
      collectConfigDocBaselineEntries(child, uiHints, itemPath, false, entries, visited);
    }
  } else if (schema.items && typeof schema.items === "object") {
    const itemSchema = asSchemaObject(schema.items);
    if (itemSchema) {
      const itemPath = normalizedPath ? `${normalizedPath}.*` : "*";
      collectConfigDocBaselineEntries(itemSchema, uiHints, itemPath, false, entries, visited);
    }
  }

  for (const branchSchema of [schema.oneOf, schema.anyOf, schema.allOf]) {
    for (const branch of branchSchema ?? []) {
      const child = asSchemaObject(branch);
      if (!child) {
        continue;
      }
      collectConfigDocBaselineEntries(child, uiHints, normalizedPath, required, entries, visited);
    }
  }

  return entries;
}

export function dedupeConfigDocBaselineEntries(
  entries: ConfigDocBaselineEntry[],
): ConfigDocBaselineEntry[] {
  const byPath = new Map<string, ConfigDocBaselineEntry>();
  for (const entry of entries) {
    const current = byPath.get(entry.path);
    byPath.set(entry.path, current ? mergeConfigDocBaselineEntry(current, entry) : entry);
  }
  return [...byPath.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

function splitConfigDocBaselineEntries(entries: ConfigDocBaselineEntry[]): {
  coreEntries: ConfigDocBaselineEntry[];
  channelEntries: ConfigDocBaselineEntry[];
  pluginEntries: ConfigDocBaselineEntry[];
} {
  const coreEntries: ConfigDocBaselineEntry[] = [];
  const channelEntries: ConfigDocBaselineEntry[] = [];
  const pluginEntries: ConfigDocBaselineEntry[] = [];

  for (const entry of entries) {
    if (entry.kind === "channel") {
      channelEntries.push(entry);
      continue;
    }
    if (entry.kind === "plugin") {
      pluginEntries.push(entry);
      continue;
    }
    coreEntries.push(entry);
  }

  return { coreEntries, channelEntries, pluginEntries };
}

export function flattenConfigDocBaselineEntries(
  baseline: ConfigDocBaseline,
): ConfigDocBaselineEntry[] {
  return [...baseline.coreEntries, ...baseline.channelEntries, ...baseline.pluginEntries];
}

async function buildConfigDocBaseline(): Promise<ConfigDocBaseline> {
  if (cachedConfigDocBaselinePromise) {
    return await cachedConfigDocBaselinePromise;
  }
  cachedConfigDocBaselinePromise = (async () => {
    const start = Date.now();
    logConfigDocBaselineDebug("build baseline start");
    const response = await loadBundledConfigSchemaResponse();
    const schemaRoot = asSchemaObject(response.schema);
    if (!schemaRoot) {
      throw new Error("config schema root is not an object");
    }
    const collectStart = Date.now();
    logConfigDocBaselineDebug("collect baseline entries start");
    const entries = dedupeConfigDocBaselineEntries(
      collectConfigDocBaselineEntries(schemaRoot, response.uiHints),
    );
    const { coreEntries, channelEntries, pluginEntries } = splitConfigDocBaselineEntries(entries);
    logConfigDocBaselineDebug(
      `collect baseline entries done count=${entries.length} elapsedMs=${Date.now() - collectStart}`,
    );
    logConfigDocBaselineDebug(`build baseline done elapsedMs=${Date.now() - start}`);
    return {
      generatedBy: GENERATED_BY,
      coreEntries,
      channelEntries,
      pluginEntries,
    };
  })();
  try {
    return await cachedConfigDocBaselinePromise;
  } catch (error) {
    cachedConfigDocBaselinePromise = null;
    throw error;
  }
}

function renderKindBaseline(
  kind: ConfigDocBaselineKind,
  entries: ConfigDocBaselineEntry[],
): string {
  const baseline: ConfigDocBaselineKindBaseline = {
    generatedBy: GENERATED_BY,
    kind,
    entries,
  };
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

export async function renderConfigDocBaselineArtifacts(
  baseline?: ConfigDocBaseline | Promise<ConfigDocBaseline>,
): Promise<ConfigDocBaselineArtifactsRender> {
  const start = Date.now();
  logConfigDocBaselineDebug("render artifacts start");
  const resolvedBaseline = baseline ? await baseline : await buildConfigDocBaseline();
  const json: ConfigDocBaselineArtifacts = {
    combined: `${JSON.stringify(resolvedBaseline, null, 2)}\n`,
    core: renderKindBaseline("core", resolvedBaseline.coreEntries),
    channel: renderKindBaseline("channel", resolvedBaseline.channelEntries),
    plugin: renderKindBaseline("plugin", resolvedBaseline.pluginEntries),
  };
  logConfigDocBaselineDebug(`render artifacts done elapsedMs=${Date.now() - start}`);
  return {
    json,
    baseline: resolvedBaseline,
  };
}

function readFileIfExists(filePath: string): string | null {
  try {
    return fsSync.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function writeFileAtomic(filePath: string, content: string): void {
  fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
  fsSync.writeFileSync(filePath, content, "utf8");
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Build the sha256 hash file content for all config baseline artifacts. */
function computeConfigBaselineHashFileContent(json: ConfigDocBaselineArtifacts): string {
  const lines = [
    `${sha256(json.combined)}  config-baseline.json`,
    `${sha256(json.core)}  config-baseline.core.json`,
    `${sha256(json.channel)}  config-baseline.channel.json`,
    `${sha256(json.plugin)}  config-baseline.plugin.json`,
  ];
  return `${lines.join("\n")}\n`;
}

function resolveBaselineArtifactPaths(
  repoRoot: string,
  params?: {
    combinedPath?: string;
    corePath?: string;
    channelPath?: string;
    pluginPath?: string;
  },
): ConfigDocBaselineArtifactPaths {
  return {
    combined: path.resolve(repoRoot, params?.combinedPath ?? DEFAULT_COMBINED_OUTPUT),
    core: path.resolve(repoRoot, params?.corePath ?? DEFAULT_CORE_OUTPUT),
    channel: path.resolve(repoRoot, params?.channelPath ?? DEFAULT_CHANNEL_OUTPUT),
    plugin: path.resolve(repoRoot, params?.pluginPath ?? DEFAULT_PLUGIN_OUTPUT),
  };
}

export async function writeConfigDocBaselineArtifacts(params?: {
  repoRoot?: string;
  check?: boolean;
  combinedPath?: string;
  corePath?: string;
  channelPath?: string;
  pluginPath?: string;
  hashPath?: string;
  rendered?: ConfigDocBaselineArtifactsRender | Promise<ConfigDocBaselineArtifactsRender>;
}): Promise<ConfigDocBaselineArtifactsWriteResult> {
  const start = Date.now();
  logConfigDocBaselineDebug("write artifacts start");
  const repoRoot = params?.repoRoot ?? resolveRepoRoot();
  const jsonPaths = resolveBaselineArtifactPaths(repoRoot, params);
  const hashPath = path.resolve(repoRoot, params?.hashPath ?? DEFAULT_HASH_OUTPUT);
  const rendered = params?.rendered
    ? await params.rendered
    : await renderConfigDocBaselineArtifacts();
  logConfigDocBaselineDebug(`render artifacts done elapsedMs=${Date.now() - start}`);

  const nextHashContent = computeConfigBaselineHashFileContent(rendered.json);
  const currentHashContent = readFileIfExists(hashPath);
  const changed = currentHashContent !== nextHashContent;
  logConfigDocBaselineDebug(
    `compare hashes done changed=${changed} elapsedMs=${Date.now() - start}`,
  );

  if (params?.check) {
    return {
      changed,
      wrote: false,
      jsonPaths,
      hashPath,
    };
  }

  // Write the hash file (tracked in git)
  writeFileAtomic(hashPath, nextHashContent);

  // Write full JSON artifacts locally (gitignored, useful for inspection)
  for (const key of Object.keys(jsonPaths) as Array<keyof ConfigDocBaselineArtifacts>) {
    writeFileAtomic(jsonPaths[key], rendered.json[key]);
  }

  return {
    changed,
    wrote: true,
    jsonPaths,
    hashPath,
  };
}

export function normalizeConfigDocBaselineHelpPath(pathValue: string): string {
  return normalizeBaselinePath(pathValue);
}
