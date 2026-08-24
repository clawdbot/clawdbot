/** Linux systemd unit paths and environment-file parsing. */
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { isUnresolvedShellReference } from "../config/state-dir-dotenv.js";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import { resolveGatewaySystemdServiceName } from "./constants.js";
import { normalizeWindowsPathSeparators } from "./output.js";
import { resolveDaemonHomeDir } from "./paths.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceEnv,
  GatewayServiceEnvironmentValueSource,
  GatewayServiceReadOptions,
} from "./service-types.js";
import { execBusctlUser } from "./systemd-exec.js";
import { parseSystemdEnvAssignments, parseSystemdExecStart } from "./systemd-unit.js";

const SYSTEMD_GATEWAY_DOTENV_FILENAME = "gateway.systemd.env";
const SYSTEMD_NODE_DOTENV_FILENAME = "node.systemd.env";
const SYSTEMD_MANAGER_QUERY_TIMEOUT_MS = 5_000;

export function resolveSystemdUnitPathForName(env: GatewayServiceEnv, name: string): string {
  const home = normalizeWindowsPathSeparators(resolveDaemonHomeDir(env));
  return path.posix.join(home, ".config", "systemd", "user", `${name}.service`);
}

export function resolveSystemdServiceName(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_SYSTEMD_UNIT?.trim();
  if (override) {
    return override.endsWith(".service") ? override.slice(0, -".service".length) : override;
  }
  return resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
}

export function resolveSystemdUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPathForName(env, resolveSystemdServiceName(env));
}

export function resolveSystemdUserUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPath(env);
}

// Unit file parsing/rendering: see systemd-unit.ts

async function readSystemdManagerExecStart(
  env: GatewayServiceEnv,
  opts?: GatewayServiceReadOptions,
): Promise<string[] | null> {
  const manager = "org.freedesktop.systemd1";
  const timeoutMs =
    opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : SYSTEMD_MANAGER_QUERY_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;
  // Both D-Bus calls share one deadline so every caller reaches the local fallback promptly.
  const query = (args: string[]) =>
    execBusctlUser(env, ["--json=short", ...args], Math.max(1, deadlineAt - Date.now()));
  const loaded = await query([
    "call",
    manager,
    "/org/freedesktop/systemd1",
    `${manager}.Manager`,
    "LoadUnit",
    "s",
    `${resolveSystemdServiceName(env)}.service`,
  ]);
  if (loaded.code !== 0) {
    return null;
  }
  const unit = asOptionalRecord(JSON.parse(loaded.stdout));
  const unitPath = Array.isArray(unit?.data) && unit.data.length === 1 ? unit.data[0] : null;
  if (unit?.type !== "o" || typeof unitPath !== "string" || !unitPath) {
    return null;
  }
  const propertyArgs = ["get-property", manager, unitPath, `${manager}.Service`, "ExecStart"];
  const result = await query(propertyArgs);
  if (result.code !== 0) {
    return null;
  }
  const property = asOptionalRecord(JSON.parse(result.stdout));
  if (
    property?.type !== "a(sasbttttuii)" ||
    !Array.isArray(property.data) ||
    property.data.length !== 1
  ) {
    return null;
  }
  const execution = property.data[0];
  const argv = Array.isArray(execution) ? execution[1] : null;
  return Array.isArray(argv) && argv.length > 0 && argv.every((arg) => typeof arg === "string")
    ? argv
    : null;
}

export async function readSystemdServiceExecStart(
  env: GatewayServiceEnv,
  opts?: GatewayServiceReadOptions,
): Promise<GatewayServiceCommandConfig | null> {
  const unitPath = resolveSystemdUnitPath(env);
  try {
    const content = await fs.readFile(unitPath, "utf8");
    let execStart = "";
    let workingDirectory = "";
    const inlineEnvironment: Record<string, string> = {};
    const environmentFileSpecs: string[] = [];
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) {
        continue;
      }
      if (line.startsWith("ExecStart=")) {
        execStart = line.slice("ExecStart=".length).trim();
      } else if (line.startsWith("WorkingDirectory=")) {
        workingDirectory = line.slice("WorkingDirectory=".length).trim();
      } else if (line.startsWith("Environment=")) {
        const raw = line.slice("Environment=".length).trim();
        for (const parsed of parseSystemdEnvAssignments(raw)) {
          inlineEnvironment[parsed.key] = parsed.value;
        }
      } else if (line.startsWith("EnvironmentFile=")) {
        const raw = line.slice("EnvironmentFile=".length).trim();
        if (raw) {
          environmentFileSpecs.push(raw);
        }
      }
    }
    if (!execStart) {
      return null;
    }
    const environmentFromFiles = await resolveSystemdEnvironmentFiles({
      environmentFileSpecs,
      env,
      unitPath,
    });
    const mergedEnvironment = {
      ...inlineEnvironment,
      ...environmentFromFiles.environment,
    };
    const mergedEnvironmentSources = mergeEnvironmentValueSources(
      inlineEnvironment,
      environmentFromFiles.environment,
    );
    // The loaded manager owns merged drop-ins; retain base-file metadata when D-Bus is offline.
    const programArguments =
      (await readSystemdManagerExecStart(env, opts).catch(() => null)) ??
      parseSystemdExecStart(execStart);
    return {
      programArguments,
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(mergedEnvironment).length > 0 ? { environment: mergedEnvironment } : {}),
      ...(Object.keys(mergedEnvironmentSources).length > 0
        ? { environmentValueSources: mergedEnvironmentSources }
        : {}),
      sourcePath: unitPath,
    };
  } catch {
    return null;
  }
}

function buildEnvironmentValueSources(
  environment: Record<string, string>,
  source: "inline" | "file",
): Record<string, GatewayServiceEnvironmentValueSource> {
  return Object.fromEntries(Object.keys(environment).map((key) => [key, source]));
}

function mergeEnvironmentValueSources(
  inlineEnvironment: Record<string, string>,
  fileEnvironment: Record<string, string>,
): Record<string, GatewayServiceEnvironmentValueSource> {
  const sources = buildEnvironmentValueSources(inlineEnvironment, "inline");
  for (const key of Object.keys(fileEnvironment)) {
    sources[key] = Object.hasOwn(inlineEnvironment, key) ? "inline-and-file" : "file";
  }
  return sources;
}

export function resolveSystemdEnvironmentFilePath(params: {
  stateDir: string;
  environment?: GatewayServiceEnv;
}): string {
  const serviceKind = params.environment?.OPENCLAW_SERVICE_KIND?.trim();
  const filename =
    serviceKind === "node" ? SYSTEMD_NODE_DOTENV_FILENAME : SYSTEMD_GATEWAY_DOTENV_FILENAME;
  return path.join(params.stateDir, filename);
}

export function resolveLegacyNodeSystemdEnvironmentFilePath(params: {
  stateDir: string;
  environment?: GatewayServiceEnv;
}): string | null {
  if (params.environment?.OPENCLAW_SERVICE_KIND?.trim() !== "node") {
    return null;
  }
  const legacyPath = path.join(params.stateDir, SYSTEMD_GATEWAY_DOTENV_FILENAME);
  const currentPath = resolveSystemdEnvironmentFilePath(params);
  return legacyPath === currentPath ? null : legacyPath;
}

export function isNodeSystemdEnvironment(env: GatewayServiceEnv): boolean {
  return env.OPENCLAW_SERVICE_KIND?.trim() === "node";
}

function expandSystemdSpecifier(input: string, env: GatewayServiceEnv): string {
  // Support the common unit-specifier used in user services.
  return input.replaceAll("%h", normalizeWindowsPathSeparators(resolveDaemonHomeDir(env)));
}

function parseEnvironmentFileSpecs(raw: string): string[] {
  return normalizeStringEntries(splitArgsPreservingQuotes(raw, { escapeMode: "backslash" }));
}

function decodeSystemdEnvironmentFileValue(rawValue: string): {
  value: string;
  literalDollar: boolean;
} {
  type ParseState =
    | "pre"
    | "unquoted"
    | "unquoted-escape"
    | "single-quoted"
    | "double-quoted"
    | "double-quoted-escape";

  // Mirror systemd's parse_env_file_internal state transitions. In particular,
  // a closing quoted segment returns to `pre`, so `"foo"bar` decodes to `foobar`.
  let state: ParseState = "pre";
  let decoded = "";
  let literalDollar = false;
  let trailingWhitespaceStart: number | undefined;
  for (const char of rawValue) {
    const whitespace = char === " " || char === "\t" || char === "\r";
    if (state === "pre") {
      if (whitespace) {
        continue;
      }
      if (char === "'") {
        state = "single-quoted";
        continue;
      }
      if (char === '"') {
        state = "double-quoted";
        continue;
      }
      if (char === "\\") {
        state = "unquoted-escape";
        continue;
      }
      state = "unquoted";
      decoded += char;
      continue;
    }
    if (state === "unquoted") {
      if (char === "\\") {
        state = "unquoted-escape";
        trailingWhitespaceStart = undefined;
        continue;
      }
      if (whitespace) {
        trailingWhitespaceStart ??= decoded.length;
      } else {
        trailingWhitespaceStart = undefined;
      }
      decoded += char;
      continue;
    }
    if (state === "unquoted-escape") {
      state = "unquoted";
      literalDollar ||= char === "$";
      decoded += char;
      continue;
    }
    if (state === "single-quoted") {
      if (char === "'") {
        state = "pre";
      } else {
        literalDollar ||= char === "$";
        decoded += char;
      }
      continue;
    }
    if (state === "double-quoted") {
      if (char === '"') {
        state = "pre";
      } else if (char === "\\") {
        state = "double-quoted-escape";
      } else {
        literalDollar ||= char === "$";
        decoded += char;
      }
      continue;
    }
    state = "double-quoted";
    if (['"', "\\", "`", "$"].includes(char)) {
      literalDollar ||= char === "$";
      decoded += char;
    } else {
      decoded += `\\${char}`;
    }
  }
  if (state === "unquoted" && trailingWhitespaceStart !== undefined) {
    decoded = decoded.slice(0, trailingWhitespaceStart);
  }
  return { value: decoded, literalDollar };
}

function parseEnvironmentFileLine(
  rawLine: string,
): { key: string; value: string; literalShellReference: boolean } | null {
  const trimmedStart = rawLine.trimStart();
  if (!trimmedStart || trimmedStart.startsWith("#") || trimmedStart.startsWith(";")) {
    return null;
  }
  const eq = trimmedStart.indexOf("=");
  if (eq <= 0) {
    return null;
  }
  const key = trimmedStart.slice(0, eq).trim();
  if (!key) {
    return null;
  }
  const decoded = decodeSystemdEnvironmentFileValue(trimmedStart.slice(eq + 1));
  return {
    key,
    value: decoded.value,
    literalShellReference: decoded.literalDollar && isUnresolvedShellReference(decoded.value),
  };
}

function serializeSystemdEnvironmentFileValue(value: string): string {
  // EnvironmentFile double quotes only unescape \", \\, \`, and \$. Escape
  // exactly that set so credentials survive systemd parsing byte-for-byte.
  if (!/[\s\\'"`$]/u.test(value)) {
    return value;
  }
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$");
  return `"${escaped}"`;
}

export function serializeSystemdEnvironmentFile(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([key, value]) => `${key}=${serializeSystemdEnvironmentFileValue(value)}`)
    .join("\n");
}

export async function readSystemdEnvironmentFile(pathname: string): Promise<{
  environment: Record<string, string>;
  literalShellReferenceKeys: Set<string>;
}> {
  const environment: Record<string, string> = {};
  const literalShellReferenceKeys = new Set<string>();
  const content = await fs.readFile(pathname, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const parsed = parseEnvironmentFileLine(rawLine);
    if (!parsed) {
      continue;
    }
    environment[parsed.key] = parsed.value;
    if (parsed.literalShellReference) {
      literalShellReferenceKeys.add(parsed.key);
    } else {
      literalShellReferenceKeys.delete(parsed.key);
    }
  }
  return { environment, literalShellReferenceKeys };
}

async function resolveSystemdEnvironmentFiles(params: {
  environmentFileSpecs: string[];
  env: GatewayServiceEnv;
  unitPath: string;
}): Promise<{ environment: Record<string, string> }> {
  const resolved: Record<string, string> = {};
  if (params.environmentFileSpecs.length === 0) {
    return { environment: resolved };
  }
  const unitDir = path.posix.dirname(params.unitPath);
  for (const specRaw of params.environmentFileSpecs) {
    for (const token of parseEnvironmentFileSpecs(specRaw)) {
      const optional = token.startsWith("-");
      const pathnameRaw = optional ? token.slice(1).trim() : token;
      if (!pathnameRaw) {
        continue;
      }
      const expanded = expandSystemdSpecifier(pathnameRaw, params.env);
      const pathname = path.posix.isAbsolute(expanded)
        ? expanded
        : path.posix.resolve(unitDir, expanded);
      try {
        const fromFile = await readSystemdEnvironmentFile(pathname);
        Object.assign(resolved, fromFile.environment);
      } catch {
        // Keep service auditing resilient even when env files are unavailable
        // in the current runtime context. Both optional and non-optional
        // EnvironmentFile entries are skipped gracefully for diagnostics.
        continue;
      }
    }
  }
  return { environment: resolved };
}
