import fs from "node:fs";
import type { Command } from "commander";
import JSON5 from "json5";
import { readConfigFileSnapshot, replaceConfigFile } from "../config/config.js";
import { formatConfigIssueLines, normalizeConfigIssues } from "../config/issue-format.js";
import { CONFIG_PATH } from "../config/paths.js";
import { isBlockedObjectKey } from "../config/prototype-keys.js";
import { redactConfigObject } from "../config/redact-snapshot.js";
import { readBestEffortRuntimeConfigSchema } from "../config/runtime-schema.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  coerceSecretRef,
  isValidEnvSecretRefId,
  resolveSecretInputRef,
  type SecretProviderConfig,
  type SecretRef,
  type SecretRefSource,
} from "../config/types.secrets.js";
import {
  collectUnsupportedSecretRefPolicyIssues,
  validateConfigObjectRaw,
} from "../config/validation.js";
import { SecretProviderSchema } from "../config/zod-schema.core.js";
import { danger, info, success } from "../globals.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidFileSecretRefId,
  isValidSecretProviderAlias,
  secretRefKey,
  validateExecSecretRefId,
} from "../secrets/ref-contract.js";
import { resolveSecretRefValue } from "../secrets/resolve.js";
import {
  discoverConfigSecretTargets,
  resolveConfigSecretTargetByPath,
} from "../secrets/target-registry.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import type {
  ConfigSetDryRunError,
  ConfigSetDryRunInputMode,
  ConfigSetDryRunResult,
} from "./config-set-dryrun.js";
import {
  hasBatchMode,
  hasProviderBuilderOptions,
  hasRefBuilderOptions,
  parseBatchSource,
  type ConfigSetBatchEntry,
  type ConfigSetOptions,
} from "./config-set-input.js";
import { resolveConfigSetMode } from "./config-set-parser.js";
import { setCommandJsonMode } from "./program/json-mode.js";

type PathSegment = string;
type ConfigSetParseOpts = {
  strictJson?: boolean;
};
type ConfigSetInputMode = ConfigSetDryRunInputMode;
type ConfigSetOperation = {
  inputMode: ConfigSetInputMode;
  requestedPath: PathSegment[];
  setPath: PathSegment[];
  value: unknown;
  mutation?: "set" | "merge" | "replace" | "delete";
  schemaValidated?: boolean;
  touchedSecretTargetPath?: string;
  touchedProviderAlias?: string;
  assignedRef?: SecretRef;
};
type ConfigPatchOptions = {
  file?: string | undefined;
  stdin?: boolean | undefined;
  dryRun?: boolean | undefined;
  allowExec?: boolean | undefined;
  json?: boolean | undefined;
  replacePath?: string[] | undefined;
};
type ConfigMutationOptions = {
  dryRun?: boolean | undefined;
  allowExec?: boolean | undefined;
  json?: boolean | undefined;
  merge?: boolean | undefined;
  replace?: boolean | undefined;
};

const GATEWAY_AUTH_MODE_PATH: PathSegment[] = ["gateway", "auth", "mode"];
const SECRET_PROVIDER_PATH_PREFIX: PathSegment[] = ["secrets", "providers"];
const PLUGIN_INSTALL_RECORD_PATH_PREFIX: PathSegment[] = ["plugins", "installs"];
const CONFIG_SET_EXAMPLE_VALUE = formatCliCommand(
  "openclaw config set gateway.port 19001 --strict-json",
);
const CONFIG_SET_EXAMPLE_REF = formatCliCommand(
  "openclaw config set channels.discord.token --ref-provider default --ref-source env --ref-id DISCORD_BOT_TOKEN",
);
const CONFIG_SET_EXAMPLE_PROVIDER = formatCliCommand(
  "openclaw config set secrets.providers.vault --provider-source file --provider-path /etc/openclaw/secrets.json --provider-mode json",
);
const CONFIG_SET_EXAMPLE_BATCH = formatCliCommand(
  "openclaw config set --batch-file ./config-set.batch.json --dry-run",
);
const CONFIG_PATCH_EXAMPLE_FILE = formatCliCommand(
  "openclaw config patch --file ./openclaw.patch.json5 --dry-run",
);
const CONFIG_PATCH_EXAMPLE_STDIN = formatCliCommand("openclaw config patch --stdin");
const CONFIG_SET_DESCRIPTION = [
  "Set config values by path (value mode, ref/provider builder mode, or batch JSON mode).",
  "Examples:",
  CONFIG_SET_EXAMPLE_VALUE,
  CONFIG_SET_EXAMPLE_REF,
  CONFIG_SET_EXAMPLE_PROVIDER,
  CONFIG_SET_EXAMPLE_BATCH,
].join("\n");
const CONFIG_PATCH_DESCRIPTION = [
  "Patch config from a JSON5 object in one validated write.",
  "Objects merge recursively, arrays/scalars replace, and null deletes a path.",
  "Examples:",
  CONFIG_PATCH_EXAMPLE_FILE,
  CONFIG_PATCH_EXAMPLE_STDIN,
].join("\n");
const CONFIG_SET_POLICY_ERROR_MAX_ISSUES = 5;
const CONFIG_PATCH_STDIN_MAX_BYTES = 1024 * 1024;

class ConfigSetDryRunValidationError extends Error {
  constructor(readonly result: ConfigSetDryRunResult) {
    super("config set dry-run validation failed");
    this.name = "ConfigSetDryRunValidationError";
  }
}

function isIndexSegment(raw: string): boolean {
  return /^[0-9]+$/.test(raw);
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

function parsePath(raw: string): PathSegment[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const parts: string[] = [];
  let current = "";
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
      if (current) {
        parts.push(current);
      }
      current = "";
      i += 1;
      continue;
    }
    if (ch === "[") {
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
      i = close + 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current) {
    parts.push(current);
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseValue(raw: string, opts: ConfigSetParseOpts): unknown {
  const trimmed = raw.trim();
  if (opts.strictJson) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Failed to parse JSON value: ${String(err)}`, { cause: err });
    }
  }

  try {
    return JSON5.parse(trimmed);
  } catch {
    return raw;
  }
}

function hasOwnPathKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function formatDoctorHint(message: string): string {
  return `Run \`${formatCliCommand("openclaw doctor")}\` ${message}`;
}

function formatUnsupportedSecretRefPolicyFailureMessage(issues: string[]): string {
  const lines = [
    "Config policy validation failed: unsupported SecretRef usage was detected.",
    ...issues.slice(0, CONFIG_SET_POLICY_ERROR_MAX_ISSUES).map((issue) => `- ${issue}`),
  ];
  if (issues.length > CONFIG_SET_POLICY_ERROR_MAX_ISSUES) {
    lines.push(`- ... ${issues.length - CONFIG_SET_POLICY_ERROR_MAX_ISSUES} more`);
  }
  return lines.join("\n");
}

function validatePathSegments(path: PathSegment[]): void {
  for (const segment of path) {
    if (!isIndexSegment(segment) && isBlockedObjectKey(segment)) {
      throw new Error(`Invalid path segment: ${segment}`);
    }
  }
}

function getAtPath(root: unknown, path: PathSegment[]): { found: boolean; value?: unknown } {
  let current: unknown = root;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return { found: false };
    }
    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) {
        return { found: false };
      }
      const index = Number.parseInt(segment, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
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

function setAtPath(root: Record<string, unknown>, path: PathSegment[], value: unknown): void {
  let current: unknown = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    const next = path[i + 1];
    const nextIsIndex = Boolean(next && isIndexSegment(next));
    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) {
        throw new Error(`Expected numeric index for array segment "${segment}"`);
      }
      const index = Number.parseInt(segment, 10);
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

  const last = path[path.length - 1];
  if (Array.isArray(current)) {
    if (!isIndexSegment(last)) {
      throw new Error(`Expected numeric index for array segment "${last}"`);
    }
    const index = Number.parseInt(last, 10);
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

function mergeAtPath(root: Record<string, unknown>, path: PathSegment[], value: unknown): void {
  const existing = getAtPath(root, path);
  if (!existing.found) {
    setAtPath(root, path, value);
    return;
  }
  setAtPath(root, path, mergeConfigValue(existing.value, value, path));
}

function isProviderModelListPath(path: PathSegment[]): boolean {
  return (
    path.length === 4 && path[0] === "models" && path[1] === "providers" && path[3] === "models"
  );
}

function isProtectedMapReplacementPath(path: PathSegment[]): boolean {
  if (path.join(".") === "agents.defaults.models") {
    return true;
  }
  if (path.join(".") === "models.providers") {
    return true;
  }
  if (path.length === 3 && path[0] === "models" && path[1] === "providers") {
    return true;
  }
  if (path.join(".") === "plugins.entries") {
    return true;
  }
  if (path.join(".") === "auth.profiles") {
    return true;
  }
  return false;
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

function assertNonDestructiveReplacement(params: {
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

function unsetAtPath(root: Record<string, unknown>, path: PathSegment[]): UnsetAtPathResult {
  let current: unknown = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    if (!current || typeof current !== "object") {
      return { removed: false };
    }
    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) {
        return { removed: false };
      }
      const index = Number.parseInt(segment, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
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

  const last = path[path.length - 1];
  if (Array.isArray(current)) {
    if (!isIndexSegment(last)) {
      return { removed: false };
    }
    const index = Number.parseInt(last, 10);
    if (!Number.isFinite(index) || index < 0 || index >= current.length) {
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

async function loadValidConfig(runtime: RuntimeEnv = defaultRuntime) {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.valid) {
    return snapshot;
  }
  runtime.error(`Config invalid at ${shortenHomePath(snapshot.path)}.`);
  for (const line of formatConfigIssueLines(snapshot.issues, "-", { normalizeRoot: true })) {
    runtime.error(line);
  }
  runtime.error(formatDoctorHint("to repair, then retry."));
  runtime.exit(1);
  return snapshot;
}

function parseRequiredPath(path: string): PathSegment[] {
  const parsedPath = parsePath(path);
  if (parsedPath.length === 0) {
    throw new Error("Path is empty.");
  }
  validatePathSegments(parsedPath);
  return parsedPath;
}

function pathEquals(path: PathSegment[], expected: PathSegment[]): boolean {
  return (
    path.length === expected.length && path.every((segment, index) => segment === expected[index])
  );
}

function pruneInactiveGatewayAuthCredentials(params: {
  root: Record<string, unknown>;
  operations: ConfigSetOperation[];
}): string[] {
  const touchedGatewayAuthMode = params.operations.some((operation) =>
    pathEquals(operation.requestedPath, GATEWAY_AUTH_MODE_PATH),
  );
  if (!touchedGatewayAuthMode) {
    return [];
  }

  const gatewayRaw = params.root.gateway;
  if (!gatewayRaw || typeof gatewayRaw !== "object" || Array.isArray(gatewayRaw)) {
    return [];
  }
  const gateway = gatewayRaw as Record<string, unknown>;
  const authRaw = gateway.auth;
  if (!authRaw || typeof authRaw !== "object" || Array.isArray(authRaw)) {
    return [];
  }
  const auth = authRaw as Record<string, unknown>;
  const mode = normalizeOptionalString(auth.mode) ?? "";

  const removedPaths: string[] = [];
  const remove = (key: "token" | "password") => {
    if (Object.hasOwn(auth, key)) {
      delete auth[key];
      removedPaths.push(`gateway.auth.${key}`);
    }
  };

  if (mode === "token") {
    remove("password");
  } else if (mode === "password") {
    remove("token");
  } else if (mode === "trusted-proxy") {
    remove("token");
    remove("password");
  }
  return removedPaths;
}

function toDotPath(path: PathSegment[]): string {
  return path.join(".");
}

function parseSecretRefSource(raw: string, label: string): SecretRefSource {
  const source = raw.trim();
  if (source === "env" || source === "file" || source === "exec") {
    return source;
  }
  throw new Error(`${label} must be one of: env, file, exec.`);
}

function parseSecretRefBuilder(params: {
  provider: string;
  source: string;
  id: string;
  fieldPrefix: string;
}): SecretRef {
  const provider = params.provider.trim();
  if (!provider) {
    throw new Error(`${params.fieldPrefix}.provider is required.`);
  }
  if (!isValidSecretProviderAlias(provider)) {
    throw new Error(
      `${params.fieldPrefix}.provider must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").`,
    );
  }

  const source = parseSecretRefSource(params.source, `${params.fieldPrefix}.source`);
  const id = params.id.trim();
  if (!id) {
    throw new Error(`${params.fieldPrefix}.id is required.`);
  }
  if (source === "env" && !isValidEnvSecretRefId(id)) {
    throw new Error(`${params.fieldPrefix}.id must match /^[A-Z][A-Z0-9_]{0,127}$/ for env refs.`);
  }
  if (source === "file" && !isValidFileSecretRefId(id)) {
    throw new Error(
      `${params.fieldPrefix}.id must be an absolute JSON pointer (or "value" for singleValue mode).`,
    );
  }
  if (source === "exec") {
    const validated = validateExecSecretRefId(id);
    if (!validated.ok) {
      throw new Error(formatExecSecretRefIdValidationMessage());
    }
  }
  return { source, provider, id };
}

function parseOptionalPositiveInteger(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${flag} must not be empty.`);
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function parseProviderEnvEntries(
  entries: string[] | undefined,
): Record<string, string> | undefined {
  if (!entries || entries.length === 0) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      throw new Error(`--provider-env expects KEY=VALUE entries (received: "${entry}").`);
    }
    const key = entry.slice(0, separator).trim();
    if (!key) {
      throw new Error(`--provider-env key must not be empty (received: "${entry}").`);
    }
    env[key] = entry.slice(separator + 1);
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function parseProviderAliasPath(path: PathSegment[]): string {
  const expectedPrefixMatches =
    path.length === 3 &&
    path[0] === SECRET_PROVIDER_PATH_PREFIX[0] &&
    path[1] === SECRET_PROVIDER_PATH_PREFIX[1];
  if (!expectedPrefixMatches) {
    throw new Error(
      'Provider builder mode requires path "secrets.providers.<alias>" (example: secrets.providers.vault).',
    );
  }
  const alias = path[2] ?? "";
  if (!isValidSecretProviderAlias(alias)) {
    throw new Error(
      `Provider alias "${alias}" must match /^[a-z][a-z0-9_-]{0,63}$/ (example: "default").`,
    );
  }
  return alias;
}

function buildProviderFromBuilder(opts: ConfigSetOptions): SecretProviderConfig {
  const sourceRaw = opts.providerSource?.trim();
  if (!sourceRaw) {
    throw new Error("--provider-source is required in provider builder mode.");
  }
  const source = parseSecretRefSource(sourceRaw, "--provider-source");
  const timeoutMs = parseOptionalPositiveInteger(opts.providerTimeoutMs, "--provider-timeout-ms");
  const maxBytes = parseOptionalPositiveInteger(opts.providerMaxBytes, "--provider-max-bytes");
  const noOutputTimeoutMs = parseOptionalPositiveInteger(
    opts.providerNoOutputTimeoutMs,
    "--provider-no-output-timeout-ms",
  );
  const maxOutputBytes = parseOptionalPositiveInteger(
    opts.providerMaxOutputBytes,
    "--provider-max-output-bytes",
  );
  const providerEnv = parseProviderEnvEntries(opts.providerEnv);

  let provider: SecretProviderConfig;
  if (source === "env") {
    const allowlist = (opts.providerAllowlist ?? []).map((entry) => entry.trim()).filter(Boolean);
    for (const envName of allowlist) {
      if (!isValidEnvSecretRefId(envName)) {
        throw new Error(
          `--provider-allowlist entry "${envName}" must match /^[A-Z][A-Z0-9_]{0,127}$/.`,
        );
      }
    }
    provider = {
      source: "env",
      ...(allowlist.length > 0 ? { allowlist } : {}),
    };
  } else if (source === "file") {
    const filePath = opts.providerPath?.trim();
    if (!filePath) {
      throw new Error("--provider-path is required when --provider-source file is used.");
    }
    const modeRaw = opts.providerMode?.trim();
    if (modeRaw && modeRaw !== "singleValue" && modeRaw !== "json") {
      throw new Error("--provider-mode must be one of: singleValue, json.");
    }
    const mode = modeRaw === "singleValue" || modeRaw === "json" ? modeRaw : undefined;
    provider = {
      source: "file",
      path: filePath,
      ...(mode ? { mode } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(opts.providerAllowInsecurePath ? { allowInsecurePath: true } : {}),
    };
  } else {
    const command = opts.providerCommand?.trim();
    if (!command) {
      throw new Error("--provider-command is required when --provider-source exec is used.");
    }
    provider = {
      source: "exec",
      command,
      ...(opts.providerArg && opts.providerArg.length > 0
        ? { args: opts.providerArg.map((entry) => entry.trim()) }
        : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(noOutputTimeoutMs !== undefined ? { noOutputTimeoutMs } : {}),
      ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
      ...(opts.providerJsonOnly ? { jsonOnly: true } : {}),
      ...(providerEnv ? { env: providerEnv } : {}),
      ...(opts.providerPassEnv && opts.providerPassEnv.length > 0
        ? { passEnv: opts.providerPassEnv.map((entry) => entry.trim()).filter(Boolean) }
        : {}),
      ...(opts.providerTrustedDir && opts.providerTrustedDir.length > 0
        ? { trustedDirs: opts.providerTrustedDir.map((entry) => entry.trim()).filter(Boolean) }
        : {}),
      ...(opts.providerAllowInsecurePath ? { allowInsecurePath: true } : {}),
      ...(opts.providerAllowSymlinkCommand ? { allowSymlinkCommand: true } : {}),
    };
  }

  const validated = SecretProviderSchema.safeParse(provider);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const issuePath = issue?.path?.join(".") ?? "<provider>";
    const issueMessage = issue?.message ?? "Invalid provider config.";
    throw new Error(`Provider builder config invalid at ${issuePath}: ${issueMessage}`);
  }
  return validated.data;
}

function parseSecretRefFromUnknown(value: unknown, label: string): SecretRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object with source/provider/id.`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.provider !== "string" ||
    typeof candidate.source !== "string" ||
    typeof candidate.id !== "string"
  ) {
    throw new Error(`${label} must include string fields: source, provider, id.`);
  }
  return parseSecretRefBuilder({
    provider: candidate.provider,
    source: candidate.source,
    id: candidate.id,
    fieldPrefix: label,
  });
}

function buildRefAssignmentOperation(params: {
  requestedPath: PathSegment[];
  ref: SecretRef;
  inputMode: ConfigSetInputMode;
}): ConfigSetOperation {
  const resolved = resolveConfigSecretTargetByPath(params.requestedPath);
  if (resolved?.entry.secretShape === "sibling_ref" && resolved.refPathSegments) {
    return {
      inputMode: params.inputMode,
      requestedPath: params.requestedPath,
      setPath: resolved.refPathSegments,
      value: params.ref,
      schemaValidated: true,
      touchedSecretTargetPath: toDotPath(resolved.pathSegments),
      assignedRef: params.ref,
      ...(resolved.providerId ? { touchedProviderAlias: resolved.providerId } : {}),
    };
  }
  return {
    inputMode: params.inputMode,
    requestedPath: params.requestedPath,
    setPath: params.requestedPath,
    value: params.ref,
    // Only registry-known SecretRef targets have had their schema shape validated here.
    ...(resolved ? { schemaValidated: true } : {}),
    touchedSecretTargetPath: resolved
      ? toDotPath(resolved.pathSegments)
      : toDotPath(params.requestedPath),
    assignedRef: params.ref,
    ...(resolved?.providerId ? { touchedProviderAlias: resolved.providerId } : {}),
  };
}

function parseProviderAliasFromTargetPath(path: PathSegment[]): string | null {
  if (
    path.length >= 3 &&
    path[0] === SECRET_PROVIDER_PATH_PREFIX[0] &&
    path[1] === SECRET_PROVIDER_PATH_PREFIX[1]
  ) {
    return path[2] ?? null;
  }
  return null;
}

function buildValueAssignmentOperation(params: {
  requestedPath: PathSegment[];
  value: unknown;
  inputMode: ConfigSetInputMode;
}): ConfigSetOperation {
  const resolved = resolveConfigSecretTargetByPath(params.requestedPath);
  const providerAlias = parseProviderAliasFromTargetPath(params.requestedPath);
  const coercedRef = coerceSecretRef(params.value);
  return {
    inputMode: params.inputMode,
    requestedPath: params.requestedPath,
    setPath: params.requestedPath,
    value: params.value,
    ...(resolved ? { touchedSecretTargetPath: toDotPath(resolved.pathSegments) } : {}),
    ...(providerAlias ? { touchedProviderAlias: providerAlias } : {}),
    ...(coercedRef ? { assignedRef: coercedRef } : {}),
  };
}

function parseBatchOperations(entries: ConfigSetBatchEntry[]): ConfigSetOperation[] {
  const operations: ConfigSetOperation[] = [];
  for (const [index, entry] of entries.entries()) {
    const path = parseRequiredPath(entry.path);
    if (entry.ref !== undefined) {
      const ref = parseSecretRefFromUnknown(entry.ref, `batch[${index}].ref`);
      operations.push(
        buildRefAssignmentOperation({
          requestedPath: path,
          ref,
          inputMode: "json",
        }),
      );
      continue;
    }
    if (entry.provider !== undefined) {
      const alias = parseProviderAliasPath(path);
      const validated = SecretProviderSchema.safeParse(entry.provider);
      if (!validated.success) {
        const issue = validated.error.issues[0];
        const issuePath = issue?.path?.join(".") ?? "<provider>";
        throw new Error(
          `batch[${index}].provider invalid at ${issuePath}: ${issue?.message ?? ""}`,
        );
      }
      operations.push({
        inputMode: "json",
        requestedPath: path,
        setPath: path,
        value: validated.data,
        schemaValidated: true,
        touchedProviderAlias: alias,
      });
      continue;
    }
    operations.push(
      buildValueAssignmentOperation({
        requestedPath: path,
        value: entry.value,
        inputMode: "json",
      }),
    );
  }
  return operations;
}

function configPatchModeError(message: string): Error {
  return new Error(`config patch mode error: ${message}`);
}

async function readStdinText(): Promise<string> {
  const chunks: string[] = [];
  let bytes = 0;
  if (process.stdin.isTTY) {
    throw configPatchModeError(
      "--stdin refuses to read from an interactive terminal; pipe input or use --file <path>.",
    );
  }
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    const text = String(chunk);
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > CONFIG_PATCH_STDIN_MAX_BYTES) {
      throw configPatchModeError(
        `--stdin input exceeds ${CONFIG_PATCH_STDIN_MAX_BYTES} bytes; use --file <path> for larger patches.`,
      );
    }
    chunks.push(text);
  }
  return chunks.join("");
}

async function readConfigPatchInput(opts: ConfigPatchOptions): Promise<unknown> {
  const file = normalizeOptionalString(opts.file);
  const stdin = Boolean(opts.stdin);
  if (Boolean(file) === stdin) {
    throw configPatchModeError("provide exactly one of --file <path> or --stdin.");
  }
  const sourceLabel = stdin ? "--stdin" : "--file";
  const raw = stdin ? await readStdinText() : fs.readFileSync(file as string, "utf8");
  try {
    return JSON5.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${sourceLabel} as JSON5: ${String(err)}`, { cause: err });
  }
}

function parseReplacePaths(paths: string[] | undefined): PathSegment[][] {
  return (paths ?? []).map((path) => parseRequiredPath(path));
}

function pathKey(path: PathSegment[]): string {
  return JSON.stringify(path);
}

function buildDeleteOperation(path: PathSegment[]): ConfigSetOperation {
  return {
    inputMode: "json",
    requestedPath: path,
    setPath: path,
    value: undefined,
    mutation: "delete",
  };
}

function buildApplyValueOperation(params: {
  path: PathSegment[];
  value: unknown;
  mutation?: ConfigSetOperation["mutation"];
}): ConfigSetOperation {
  const ref = isPlainRecord(params.value) ? coerceSecretRef(params.value) : null;
  if (ref) {
    return {
      ...buildRefAssignmentOperation({
        requestedPath: params.path,
        ref: parseSecretRefFromUnknown(params.value, `patch.${toDotPath(params.path)}`),
        inputMode: "json",
      }),
      ...(params.mutation ? { mutation: params.mutation } : {}),
    };
  }
  return {
    ...buildValueAssignmentOperation({
      requestedPath: params.path,
      value: params.value,
      inputMode: "json",
    }),
    ...(params.mutation ? { mutation: params.mutation } : {}),
  };
}

function buildConfigPatchOperations(params: {
  patch: unknown;
  replacePaths: PathSegment[][];
}): ConfigSetOperation[] {
  if (!isPlainRecord(params.patch)) {
    throw configPatchModeError("input must be a JSON5 object patch.");
  }
  const operations: ConfigSetOperation[] = [];
  const replacePathKeys = new Set(params.replacePaths.map(pathKey));
  const matchedReplacePathKeys = new Set<string>();
  const visit = (value: unknown, path: PathSegment[]) => {
    validatePathSegments(path);
    const replacementKey = pathKey(path);
    if (path.length > 0 && replacePathKeys.has(replacementKey)) {
      matchedReplacePathKeys.add(replacementKey);
      operations.push(
        value === null
          ? buildDeleteOperation(path)
          : buildApplyValueOperation({ path, value, mutation: "replace" }),
      );
      return;
    }
    if (path.length > 0 && value === null) {
      operations.push(buildDeleteOperation(path));
      return;
    }
    if (path.length > 0 && isPlainRecord(value) && coerceSecretRef(value)) {
      operations.push(buildApplyValueOperation({ path, value }));
      return;
    }
    if (isPlainRecord(value)) {
      if (path.length > 0 && Object.keys(value).length === 0) {
        operations.push(buildApplyValueOperation({ path, value, mutation: "merge" }));
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        visit(child, [...path, key]);
      }
      return;
    }
    if (path.length === 0) {
      throw configPatchModeError("input must contain at least one config key.");
    }
    operations.push(buildApplyValueOperation({ path, value }));
  };

  visit(params.patch, []);
  const unusedReplacePath = params.replacePaths.find(
    (path) => !matchedReplacePathKeys.has(pathKey(path)),
  );
  if (unusedReplacePath) {
    throw configPatchModeError(
      `--replace-path ${toDotPath(unusedReplacePath)} did not match any value in the input patch.`,
    );
  }
  if (operations.length === 0) {
    throw configPatchModeError("input patch did not contain any config updates.");
  }
  return operations;
}

function collectSecretRefsFromUnknown(value: unknown): SecretRef[] {
  const refs: SecretRef[] = [];
  const visit = (candidate: unknown) => {
    const ref = coerceSecretRef(candidate);
    if (ref) {
      refs.push(ref);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) {
        visit(entry);
      }
      return;
    }
    if (isPlainRecord(candidate)) {
      for (const entry of Object.values(candidate)) {
        visit(entry);
      }
    }
  };
  visit(value);
  return refs;
}

function modeError(message: string): Error {
  return new Error(`config set mode error: ${message}`);
}

function buildSingleSetOperations(params: {
  path?: string;
  value?: string;
  opts: ConfigSetOptions;
}): ConfigSetOperation[] {
  const pathProvided = typeof params.path === "string" && params.path.trim().length > 0;
  const parsedPath = pathProvided ? parseRequiredPath(params.path as string) : null;
  const strictJson = Boolean(params.opts.strictJson || params.opts.json);
  const modeResolution = resolveConfigSetMode({
    hasBatchMode: false,
    hasRefBuilderOptions: hasRefBuilderOptions(params.opts),
    hasProviderBuilderOptions: hasProviderBuilderOptions(params.opts),
    strictJson,
  });
  if (!modeResolution.ok) {
    throw modeError(modeResolution.error);
  }

  if (modeResolution.mode === "ref_builder") {
    if (!pathProvided || !parsedPath) {
      throw modeError("ref builder mode requires <path>.");
    }
    if (params.value !== undefined) {
      throw modeError("ref builder mode does not accept <value>.");
    }
    if (!params.opts.refProvider || !params.opts.refSource || !params.opts.refId) {
      throw modeError(
        "ref builder mode requires --ref-provider <alias>, --ref-source <env|file|exec>, and --ref-id <id>.",
      );
    }
    const ref = parseSecretRefBuilder({
      provider: params.opts.refProvider,
      source: params.opts.refSource,
      id: params.opts.refId,
      fieldPrefix: "ref",
    });
    return [
      buildRefAssignmentOperation({
        requestedPath: parsedPath,
        ref,
        inputMode: "builder",
      }),
    ];
  }

  if (modeResolution.mode === "provider_builder") {
    if (!pathProvided || !parsedPath) {
      throw modeError("provider builder mode requires <path>.");
    }
    if (params.value !== undefined) {
      throw modeError("provider builder mode does not accept <value>.");
    }
    const alias = parseProviderAliasPath(parsedPath);
    const provider = buildProviderFromBuilder(params.opts);
    return [
      {
        inputMode: "builder",
        requestedPath: parsedPath,
        setPath: parsedPath,
        value: provider,
        schemaValidated: true,
        touchedProviderAlias: alias,
      },
    ];
  }

  if (!pathProvided || !parsedPath) {
    throw modeError("value/json mode requires <path> when batch mode is not used.");
  }
  if (params.value === undefined) {
    throw modeError("value/json mode requires <value>.");
  }
  const parsedValue = parseValue(params.value, { strictJson });
  return [
    buildValueAssignmentOperation({
      requestedPath: parsedPath,
      value: parsedValue,
      inputMode: modeResolution.mode === "json" ? "json" : "value",
    }),
  ];
}

function collectDryRunRefs(params: {
  config: OpenClawConfig;
  operations: ConfigSetOperation[];
}): SecretRef[] {
  const refsByKey = new Map<string, SecretRef>();
  const targetPaths = new Set<string>();
  const providerAliases = new Set<string>();

  for (const operation of params.operations) {
    if (operation.assignedRef) {
      refsByKey.set(secretRefKey(operation.assignedRef), operation.assignedRef);
    }
    for (const ref of collectSecretRefsFromUnknown(operation.value)) {
      refsByKey.set(secretRefKey(ref), ref);
    }
    if (operation.touchedSecretTargetPath) {
      targetPaths.add(operation.touchedSecretTargetPath);
    }
    if (operation.touchedProviderAlias) {
      providerAliases.add(operation.touchedProviderAlias);
    }
  }

  if (targetPaths.size === 0 && providerAliases.size === 0) {
    return [...refsByKey.values()];
  }

  const defaults = params.config.secrets?.defaults;
  for (const target of discoverConfigSecretTargets(params.config)) {
    const { ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults,
    });
    if (!ref) {
      continue;
    }
    if (targetPaths.has(target.path) || providerAliases.has(ref.provider)) {
      refsByKey.set(secretRefKey(ref), ref);
    }
  }
  return [...refsByKey.values()];
}

async function collectDryRunResolvabilityErrors(params: {
  refs: SecretRef[];
  config: OpenClawConfig;
}): Promise<ConfigSetDryRunError[]> {
  const failures: ConfigSetDryRunError[] = [];
  for (const ref of params.refs) {
    try {
      await resolveSecretRefValue(ref, {
        config: params.config,
        env: process.env,
      });
    } catch (err) {
      failures.push({
        kind: "resolvability",
        message: String(err),
        ref: `${ref.source}:${ref.provider}:${ref.id}`,
      });
    }
  }
  return failures;
}

function collectDryRunStaticErrorsForSkippedExecRefs(params: {
  refs: SecretRef[];
  config: OpenClawConfig;
}): ConfigSetDryRunError[] {
  const failures: ConfigSetDryRunError[] = [];
  for (const ref of params.refs) {
    const id = ref.id.trim();
    const refLabel = `${ref.source}:${ref.provider}:${id}`;
    if (!id) {
      failures.push({
        kind: "resolvability",
        message: "Error: Secret reference id is empty.",
        ref: refLabel,
      });
      continue;
    }
    if (!isValidExecSecretRefId(id)) {
      failures.push({
        kind: "resolvability",
        message: `Error: ${formatExecSecretRefIdValidationMessage()} (ref: ${refLabel}).`,
        ref: refLabel,
      });
      continue;
    }
    const providerConfig = params.config.secrets?.providers?.[ref.provider];
    if (!providerConfig) {
      failures.push({
        kind: "resolvability",
        message: `Error: Secret provider "${ref.provider}" is not configured (ref: ${refLabel}).`,
        ref: refLabel,
      });
      continue;
    }
    if (providerConfig.source !== ref.source) {
      failures.push({
        kind: "resolvability",
        message: `Error: Secret provider "${ref.provider}" has source "${providerConfig.source}" but ref requests "${ref.source}".`,
        ref: refLabel,
      });
    }
  }
  return failures;
}

function selectDryRunRefsForResolution(params: { refs: SecretRef[]; allowExecInDryRun: boolean }): {
  refsToResolve: SecretRef[];
  skippedExecRefs: SecretRef[];
} {
  const refsToResolve: SecretRef[] = [];
  const skippedExecRefs: SecretRef[] = [];
  for (const ref of params.refs) {
    if (ref.source === "exec" && !params.allowExecInDryRun) {
      skippedExecRefs.push(ref);
      continue;
    }
    refsToResolve.push(ref);
  }
  return { refsToResolve, skippedExecRefs };
}

function pathStartsWith(path: readonly PathSegment[], prefix: readonly PathSegment[]): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}

function formatPluginInstallConfigSetError(): string {
  return [
    "plugins.installs is managed by the plugin index and cannot be edited with config set.",
    "",
    "Use plugin commands instead:",
    `  ${formatCliCommand("openclaw plugins install <spec>")}`,
    `  ${formatCliCommand("openclaw plugins update <plugin-id>")}`,
    `  ${formatCliCommand("openclaw plugins uninstall <plugin-id>")}`,
  ].join("\n");
}

function collectDryRunSchemaErrors(params: {
  config: OpenClawConfig;
  operations: ReadonlyArray<ConfigSetOperation>;
}): ConfigSetDryRunError[] {
  const validated = validateConfigObjectRaw(params.config, {
    touchedPaths: params.operations.map((operation) => operation.setPath),
    validateBundledChannels: true,
  });
  if (validated.ok) {
    return [];
  }
  return formatConfigIssueLines(validated.issues, "-", { normalizeRoot: true }).map((message) => ({
    kind: "schema",
    message,
  }));
}

function dedupeDryRunErrors(errors: ConfigSetDryRunError[]): ConfigSetDryRunError[] {
  const deduped: ConfigSetDryRunError[] = [];
  const seen = new Set<string>();
  for (const error of errors) {
    const key =
      error.kind === "resolvability"
        ? `${error.kind}\u0000${error.ref ?? ""}\u0000${error.message}`
        : `${error.kind}\u0000${error.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(error);
  }
  return deduped;
}

function formatDryRunFailureMessage(params: {
  errors: ConfigSetDryRunError[];
  skippedExecRefs: number;
}): string {
  const { errors, skippedExecRefs } = params;
  const schemaErrors = errors.filter((error) => error.kind === "schema");
  const resolveErrors = errors.filter((error) => error.kind === "resolvability");
  const lines: string[] = [];
  if (schemaErrors.length > 0) {
    lines.push("Dry run failed: config schema validation failed.");
    lines.push(...schemaErrors.map((error) => `- ${error.message}`));
  }
  if (resolveErrors.length > 0) {
    lines.push(
      `Dry run failed: ${resolveErrors.length} SecretRef assignment(s) could not be resolved.`,
    );
    lines.push(
      ...resolveErrors
        .slice(0, 5)
        .map((error) => `- ${error.ref ?? "<unknown-ref>"} -> ${error.message}`),
    );
    if (resolveErrors.length > 5) {
      lines.push(`- ... ${resolveErrors.length - 5} more`);
    }
  }
  if (skippedExecRefs > 0) {
    lines.push(
      `Dry run note: skipped ${skippedExecRefs} exec SecretRef resolvability check(s). Re-run with --allow-exec to execute exec providers during dry-run.`,
    );
  }
  return lines.join("\n");
}

async function runConfigOperations(params: {
  runtime: RuntimeEnv;
  operations: ConfigSetOperation[];
  options: ConfigMutationOptions;
  successMode: "set" | "patch";
}) {
  const { runtime, operations, options } = params;
  if (
    operations.some((operation) =>
      pathStartsWith(operation.requestedPath, PLUGIN_INSTALL_RECORD_PATH_PREFIX),
    )
  ) {
    throw new Error(formatPluginInstallConfigSetError());
  }
  const snapshot = await loadValidConfig(runtime);
  // Use snapshot.resolved (config after $include and ${ENV} resolution, but BEFORE runtime defaults)
  // instead of snapshot.config (runtime-merged with defaults).
  // This prevents runtime defaults from leaking into the written config file (issue #6070)
  const next = structuredClone(snapshot.resolved) as Record<string, unknown>;
  const unsetPaths: PathSegment[][] = [];
  for (const operation of operations) {
    if (operation.mutation === "delete") {
      unsetAtPath(next, operation.setPath);
      unsetPaths.push(operation.setPath);
      continue;
    }
    if (operation.mutation === "merge" || (options.merge && operation.mutation !== "replace")) {
      mergeAtPath(next, operation.setPath, operation.value);
    } else {
      assertNonDestructiveReplacement({
        root: next,
        path: operation.setPath,
        value: operation.value,
        allowReplace: options.replace || operation.mutation === "replace",
      });
      setAtPath(next, operation.setPath, operation.value);
    }
  }
  const removedGatewayAuthPaths = pruneInactiveGatewayAuthCredentials({
    root: next,
    operations,
  });
  const nextConfig = next as OpenClawConfig;
  const policyIssues = collectUnsupportedSecretRefPolicyIssues(nextConfig);
  const policyIssueLines = formatConfigIssueLines(policyIssues, "", { normalizeRoot: true }).map(
    (line) => line.trim(),
  );

  if (options.dryRun) {
    const hasJsonMode = operations.some((operation) => operation.inputMode === "json");
    const hasBuilderMode = operations.some((operation) => operation.inputMode === "builder");
    const requiresFullSchemaValidation = operations.some(
      (operation) => operation.inputMode === "json" && operation.schemaValidated !== true,
    );
    const refs =
      hasJsonMode || hasBuilderMode
        ? collectDryRunRefs({
            config: nextConfig,
            operations,
          })
        : [];
    const selectedDryRunRefs = selectDryRunRefsForResolution({
      refs,
      allowExecInDryRun: Boolean(options.allowExec),
    });
    const errors: ConfigSetDryRunError[] = [];
    if ((!hasJsonMode || !requiresFullSchemaValidation) && policyIssueLines.length > 0) {
      errors.push(
        ...policyIssueLines.map((message) => ({
          kind: "schema" as const,
          message,
        })),
      );
    }
    if (requiresFullSchemaValidation) {
      errors.push(
        ...collectDryRunSchemaErrors({
          config: nextConfig,
          operations,
        }),
      );
    }
    if (hasJsonMode || hasBuilderMode) {
      errors.push(
        ...collectDryRunStaticErrorsForSkippedExecRefs({
          refs: selectedDryRunRefs.skippedExecRefs,
          config: nextConfig,
        }),
      );
      errors.push(
        ...(await collectDryRunResolvabilityErrors({
          refs: selectedDryRunRefs.refsToResolve,
          config: nextConfig,
        })),
      );
    }
    const dedupedErrors = dedupeDryRunErrors(errors);
    const dryRunResult: ConfigSetDryRunResult = {
      ok: dedupedErrors.length === 0,
      operations: operations.length,
      configPath: shortenHomePath(snapshot.path),
      inputModes: [...new Set(operations.map((operation) => operation.inputMode))],
      checks: {
        schema: requiresFullSchemaValidation || policyIssueLines.length > 0,
        resolvability: hasJsonMode || hasBuilderMode,
        resolvabilityComplete:
          (hasJsonMode || hasBuilderMode) && selectedDryRunRefs.skippedExecRefs.length === 0,
      },
      refsChecked: selectedDryRunRefs.refsToResolve.length,
      skippedExecRefs: selectedDryRunRefs.skippedExecRefs.length,
      ...(dedupedErrors.length > 0 ? { errors: dedupedErrors } : {}),
    };
    if (dedupedErrors.length > 0) {
      if (options.json) {
        throw new ConfigSetDryRunValidationError(dryRunResult);
      }
      throw new Error(
        formatDryRunFailureMessage({
          errors: dedupedErrors,
          skippedExecRefs: selectedDryRunRefs.skippedExecRefs.length,
        }),
      );
    }
    if (options.json) {
      writeRuntimeJson(runtime, dryRunResult);
    } else {
      if (!dryRunResult.checks.schema && !dryRunResult.checks.resolvability) {
        runtime.log(
          info(
            "Dry run note: value mode does not run schema/resolvability checks. Use --strict-json, builder flags, or batch mode to enable validation checks.",
          ),
        );
      }
      if (dryRunResult.skippedExecRefs > 0) {
        runtime.log(
          info(
            `Dry run note: skipped ${dryRunResult.skippedExecRefs} exec SecretRef resolvability check(s). Re-run with --allow-exec to execute exec providers during dry-run.`,
          ),
        );
      }
      runtime.log(
        info(
          `Dry run successful: ${operations.length} update(s) validated against ${shortenHomePath(snapshot.path)}.`,
        ),
      );
    }
    return;
  }
  if (policyIssueLines.length > 0) {
    throw new Error(formatUnsupportedSecretRefPolicyFailureMessage(policyIssueLines));
  }

  await replaceConfigFile({
    nextConfig: next,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
    ...(unsetPaths.length > 0 ? { writeOptions: { unsetPaths } } : {}),
  });
  if (removedGatewayAuthPaths.length > 0) {
    runtime.log(
      info(
        `Removed inactive ${removedGatewayAuthPaths.join(", ")} for gateway.auth.mode=${nextConfig.gateway?.auth?.mode ?? "<unset>"}.`,
      ),
    );
  }
  if (params.successMode === "set" && operations.length === 1) {
    const operation = operations[0];
    const action = operation?.mutation === "delete" ? "Removed" : "Updated";
    runtime.log(
      info(`${action} ${toDotPath(operation?.requestedPath ?? [])}. Restart the gateway to apply.`),
    );
    return;
  }
  if (params.successMode === "set") {
    runtime.log(info(`Updated ${operations.length} config paths. Restart the gateway to apply.`));
    return;
  }
  runtime.log(info(`Applied ${operations.length} config update(s). Restart the gateway to apply.`));
}

function handleConfigMutationError(params: {
  err: unknown;
  runtime: RuntimeEnv;
  options: ConfigMutationOptions;
}) {
  if (
    params.options.dryRun &&
    params.options.json &&
    params.err instanceof ConfigSetDryRunValidationError
  ) {
    writeRuntimeJson(params.runtime, params.err.result);
    params.runtime.exit(1);
    return;
  }
  params.runtime.error(danger(String(params.err)));
  params.runtime.exit(1);
}

export async function runConfigSet(opts: {
  path?: string;
  value?: string;
  cliOptions: ConfigSetOptions;
  runtime?: RuntimeEnv;
}) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    const isBatchMode = hasBatchMode(opts.cliOptions);
    const modeResolution = resolveConfigSetMode({
      hasBatchMode: isBatchMode,
      hasRefBuilderOptions: hasRefBuilderOptions(opts.cliOptions),
      hasProviderBuilderOptions: hasProviderBuilderOptions(opts.cliOptions),
      strictJson: Boolean(opts.cliOptions.strictJson || opts.cliOptions.json),
    });
    if (!modeResolution.ok) {
      throw modeError(modeResolution.error);
    }
    if (opts.cliOptions.allowExec && !opts.cliOptions.dryRun) {
      throw modeError("--allow-exec requires --dry-run.");
    }
    if (opts.cliOptions.merge && opts.cliOptions.replace) {
      throw modeError("choose either --merge or --replace, not both.");
    }

    const batchEntries = parseBatchSource(opts.cliOptions);
    if (batchEntries) {
      if (opts.path !== undefined || opts.value !== undefined) {
        throw modeError("batch mode does not accept <path> or <value> arguments.");
      }
    }
    const operations = batchEntries
      ? parseBatchOperations(batchEntries)
      : buildSingleSetOperations({
          path: opts.path,
          value: opts.value,
          opts: opts.cliOptions,
        });
    await runConfigOperations({
      runtime,
      operations,
      options: opts.cliOptions,
      successMode: "set",
    });
  } catch (err) {
    handleConfigMutationError({ err, runtime, options: opts.cliOptions });
  }
}

export async function runConfigPatch(opts: {
  cliOptions: ConfigPatchOptions;
  runtime?: RuntimeEnv;
}) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    if (opts.cliOptions.allowExec && !opts.cliOptions.dryRun) {
      throw configPatchModeError("--allow-exec requires --dry-run.");
    }
    if (opts.cliOptions.json && !opts.cliOptions.dryRun) {
      throw configPatchModeError("--json requires --dry-run.");
    }
    const patch = await readConfigPatchInput(opts.cliOptions);
    const operations = buildConfigPatchOperations({
      patch,
      replacePaths: parseReplacePaths(opts.cliOptions.replacePath),
    });
    await runConfigOperations({
      runtime,
      operations,
      options: {
        dryRun: opts.cliOptions.dryRun,
        allowExec: opts.cliOptions.allowExec,
        json: opts.cliOptions.json,
      },
      successMode: "patch",
    });
  } catch (err) {
    handleConfigMutationError({ err, runtime, options: opts.cliOptions });
  }
}

export async function runConfigGet(opts: { path: string; json?: boolean; runtime?: RuntimeEnv }) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    const parsedPath = parseRequiredPath(opts.path);
    const snapshot = await loadValidConfig(runtime);
    const redacted = redactConfigObject(snapshot.config);
    const res = getAtPath(redacted, parsedPath);
    if (!res.found) {
      runtime.error(danger(`Config path not found: ${opts.path}`));
      runtime.exit(1);
      return;
    }
    if (opts.json) {
      writeRuntimeJson(runtime, res.value ?? null);
      return;
    }
    if (
      typeof res.value === "string" ||
      typeof res.value === "number" ||
      typeof res.value === "boolean"
    ) {
      runtime.log(String(res.value));
      return;
    }
    writeRuntimeJson(runtime, res.value ?? null);
  } catch (err) {
    runtime.error(danger(String(err)));
    runtime.exit(1);
  }
}

export async function runConfigUnset(opts: { path: string; runtime?: RuntimeEnv }) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    const parsedPath = parseRequiredPath(opts.path);
    const snapshot = await loadValidConfig(runtime);
    // Use snapshot.resolved (config after $include and ${ENV} resolution, but BEFORE runtime defaults)
    // instead of snapshot.config (runtime-merged with defaults).
    // This prevents runtime defaults from leaking into the written config file (issue #6070)
    const next = structuredClone(snapshot.resolved) as Record<string, unknown>;
    const unsetResult = unsetAtPath(next, parsedPath);
    if (!unsetResult.removed) {
      runtime.error(danger(`Config path not found: ${opts.path}`));
      runtime.exit(1);
      return;
    }
    await replaceConfigFile({
      nextConfig: next,
      ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
      ...(unsetResult.leafContainer === "array"
        ? {}
        : { writeOptions: { unsetPaths: [parsedPath] } }),
    });
    runtime.log(info(`Removed ${opts.path}. Restart the gateway to apply.`));
  } catch (err) {
    runtime.error(danger(String(err)));
    runtime.exit(1);
  }
}

export async function runConfigFile(opts: { runtime?: RuntimeEnv }) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    const snapshot = await readConfigFileSnapshot();
    runtime.log(shortenHomePath(snapshot.path));
  } catch (err) {
    runtime.error(danger(String(err)));
    runtime.exit(1);
  }
}

async function buildCliConfigSchema(): Promise<Record<string, unknown>> {
  const schema = structuredClone((await readBestEffortRuntimeConfigSchema()).schema) as {
    properties?: Record<string, unknown>;
    required?: string[];
  };

  schema.properties = {
    $schema: { type: "string" },
    ...schema.properties,
  };

  return schema;
}

export async function runConfigSchema(opts: { runtime?: RuntimeEnv } = {}) {
  const runtime = opts.runtime ?? defaultRuntime;
  try {
    writeRuntimeJson(runtime, await buildCliConfigSchema());
  } catch (err) {
    runtime.error(danger(`Config schema error: ${String(err)}`));
    runtime.exit(1);
  }
}

export async function runConfigValidate(opts: { json?: boolean; runtime?: RuntimeEnv } = {}) {
  const runtime = opts.runtime ?? defaultRuntime;
  let outputPath = CONFIG_PATH ?? "openclaw.json";

  try {
    const snapshot = await readConfigFileSnapshot();
    outputPath = snapshot.path;
    const shortPath = shortenHomePath(outputPath);

    if (!snapshot.exists) {
      if (opts.json) {
        writeRuntimeJson(runtime, { valid: false, path: outputPath, error: "file not found" }, 0);
      } else {
        runtime.error(danger(`Config file not found: ${shortPath}`));
      }
      runtime.exit(1);
      return;
    }

    if (!snapshot.valid) {
      const issues = normalizeConfigIssues(snapshot.issues);

      if (opts.json) {
        writeRuntimeJson(runtime, { valid: false, path: outputPath, issues });
      } else {
        runtime.error(danger(`Config invalid at ${shortPath}:`));
        for (const line of formatConfigIssueLines(issues, danger("×"), { normalizeRoot: true })) {
          runtime.error(`  ${line}`);
        }
        runtime.error("");
        runtime.error(formatDoctorHint("to repair, or fix the keys above manually."));
      }
      runtime.exit(1);
      return;
    }

    if (opts.json) {
      writeRuntimeJson(runtime, { valid: true, path: outputPath }, 0);
    } else {
      runtime.log(success(`Config valid: ${shortPath}`));
    }
  } catch (err) {
    if (opts.json) {
      writeRuntimeJson(runtime, { valid: false, path: outputPath, error: String(err) }, 0);
    } else {
      runtime.error(danger(`Config validation error: ${String(err)}`));
    }
    runtime.exit(1);
  }
}

export function registerConfigCli(program: Command) {
  const cmd = program
    .command("config")
    .description(
      "Non-interactive config helpers (get/set/patch/unset/file/schema/validate). Run without subcommand for guided setup.",
    )
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/config", "docs.openclaw.ai/cli/config")}\n`,
    )
    .option(
      "--section <section>",
      "Configuration sections for guided setup (repeatable). Use with no subcommand.",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (opts) => {
      const { configureCommandFromSectionsArg } = await import("../commands/configure.js");
      await configureCommandFromSectionsArg(opts.section, defaultRuntime);
    });

  cmd
    .command("get")
    .description("Get a config value by dot path")
    .argument("<path>", "Config path (dot or bracket notation)")
    .option("--json", "Output JSON", false)
    .action(async (path: string, opts) => {
      await runConfigGet({ path, json: Boolean(opts.json) });
    });

  setCommandJsonMode(cmd.command("set"), "parse-only")
    .description(CONFIG_SET_DESCRIPTION)
    .argument("[path]", "Config path (dot or bracket notation)")
    .argument("[value]", "Value (JSON/JSON5 or raw string)")
    .option("--strict-json", "Strict JSON parsing (error instead of raw string fallback)", false)
    .option("--json", "Legacy alias for --strict-json", false)
    .option(
      "--dry-run",
      "Validate changes without writing openclaw.json (checks run in builder/json/batch modes; exec SecretRefs are skipped unless --allow-exec is set)",
      false,
    )
    .option(
      "--allow-exec",
      "Dry-run only: allow exec SecretRef resolvability checks (may execute provider commands)",
      false,
    )
    .option("--merge", "Merge object/map values instead of replacing the target path", false)
    .option(
      "--replace",
      "Allow full replacement of protected map/list paths such as agents.defaults.models",
      false,
    )
    .option("--ref-provider <alias>", "SecretRef builder: provider alias")
    .option("--ref-source <source>", "SecretRef builder: source (env|file|exec)")
    .option("--ref-id <id>", "SecretRef builder: ref id")
    .option("--provider-source <source>", "Provider builder: source (env|file|exec)")
    .option(
      "--provider-allowlist <envVar>",
      "Provider builder (env): allowlist entry (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--provider-path <path>", "Provider builder (file): path")
    .option("--provider-mode <mode>", "Provider builder (file): mode (singleValue|json)")
    .option("--provider-timeout-ms <ms>", "Provider builder (file|exec): timeout ms")
    .option("--provider-max-bytes <bytes>", "Provider builder (file): max bytes")
    .option("--provider-command <path>", "Provider builder (exec): absolute command path")
    .option(
      "--provider-arg <arg>",
      "Provider builder (exec): command arg (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--provider-no-output-timeout-ms <ms>", "Provider builder (exec): no-output timeout ms")
    .option("--provider-max-output-bytes <bytes>", "Provider builder (exec): max output bytes")
    .option("--provider-json-only", "Provider builder (exec): require JSON output", false)
    .option(
      "--provider-env <key=value>",
      "Provider builder (exec): env assignment (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--provider-pass-env <envVar>",
      "Provider builder (exec): pass host env var (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--provider-trusted-dir <path>",
      "Provider builder (exec): trusted directory (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--provider-allow-insecure-path",
      "Provider builder (file|exec): bypass strict path permission checks",
      false,
    )
    .option(
      "--provider-allow-symlink-command",
      "Provider builder (exec): allow command symlink path",
      false,
    )
    .option("--batch-json <json>", "Batch mode: JSON array of set operations")
    .option("--batch-file <path>", "Batch mode: read JSON array of set operations from file")
    .action(async (path: string | undefined, value: string | undefined, opts: ConfigSetOptions) => {
      await runConfigSet({
        path,
        value,
        cliOptions: opts,
      });
    });

  cmd
    .command("patch")
    .description(CONFIG_PATCH_DESCRIPTION)
    .option("--file <path>", "Read a JSON5 config patch object from file")
    .option("--stdin", "Read a JSON5 config patch object from stdin", false)
    .option(
      "--dry-run",
      "Validate changes without writing openclaw.json (checks schema and SecretRef resolvability; exec SecretRefs are skipped unless --allow-exec is set)",
      false,
    )
    .option(
      "--allow-exec",
      "Dry-run only: allow exec SecretRef resolvability checks (may execute provider commands)",
      false,
    )
    .option("--json", "Output dry-run result as JSON", false)
    .option(
      "--replace-path <path>",
      "Replace the object or array at this dot/bracket path instead of recursively applying it (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .action(async (opts: ConfigPatchOptions) => {
      await runConfigPatch({ cliOptions: opts });
    });

  cmd
    .command("unset")
    .description("Remove a config value by dot path")
    .argument("<path>", "Config path (dot or bracket notation)")
    .action(async (path: string) => {
      await runConfigUnset({ path });
    });

  cmd
    .command("file")
    .description("Print the active config file path")
    .action(async () => {
      await runConfigFile({});
    });

  cmd
    .command("schema")
    .description("Print the JSON schema for openclaw.json")
    .action(async () => {
      await runConfigSchema({});
    });

  cmd
    .command("validate")
    .description("Validate the current config against the schema without starting the gateway")
    .option("--json", "Output validation result as JSON", false)
    .action(async (opts) => {
      await runConfigValidate({ json: Boolean(opts.json) });
    });
}
