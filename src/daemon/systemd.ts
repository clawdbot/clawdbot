/** Linux systemd user service installer, parser, and lifecycle controls. */
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveStateDir } from "../config/paths.js";
import {
  isUnresolvedShellReference,
  readStateDirDotEnvFromStateDir,
} from "../config/state-dir-dotenv.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeEnvVarKey } from "../infra/host-env-security.js";
import {
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "../infra/parse-finite-number.js";
import { splitArgsPreservingQuotes } from "./arg-split.js";
import {
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  resolveGatewayServiceDescription,
  resolveGatewaySystemdServiceName,
} from "./constants.js";
import { execFileUtf8 } from "./exec-file.js";
import { formatLine, toPosixPath, writeFormattedLines } from "./output.js";
import { resolveHomeDir } from "./paths.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import {
  hasEnvironmentFileSource,
  hasInlineEnvironmentSource,
  isEnvironmentFileOnlySource,
  readManagedServiceEnvKeysFromEnvironment,
} from "./service-managed-env.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceEnvironmentValueSource,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
  GatewayServiceReadOptions,
  GatewayServiceRestartResult,
} from "./service-types.js";
import { enableSystemdUserLinger, readSystemdUserLingerStatus } from "./systemd-linger.js";
import {
  classifySystemdUnavailableDetail,
  isSystemctlMissingDetail,
  isSystemdUserBusUnavailableDetail,
} from "./systemd-unavailable.js";
import {
  buildSystemdUnit,
  parseSystemdEnvAssignment,
  parseSystemdEnvAssignments,
  parseSystemdExecStart,
  renderSystemdEnvAssignment,
} from "./systemd-unit.js";

const SYSTEMD_GATEWAY_DOTENV_FILENAME = "gateway.systemd.env";
const SYSTEMD_NODE_DOTENV_FILENAME = "node.systemd.env";

function resolveSystemdUnitPathForName(env: GatewayServiceEnv, name: string): string {
  const home = toPosixPath(resolveHomeDir(env));
  return path.posix.join(home, ".config", "systemd", "user", `${name}.service`);
}

function resolveSystemdServiceName(env: GatewayServiceEnv): string {
  const override = env.OPENCLAW_SYSTEMD_UNIT?.trim();
  if (override) {
    return override.endsWith(".service") ? override.slice(0, -".service".length) : override;
  }
  return resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE);
}

function resolveSystemdUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPathForName(env, resolveSystemdServiceName(env));
}

export function resolveSystemdUserUnitPath(env: GatewayServiceEnv): string {
  return resolveSystemdUnitPath(env);
}

const SYSTEM_SYSTEMD_UNIT_DIRS = [
  "/etc/systemd/system",
  "/usr/lib/systemd/system",
  "/lib/systemd/system",
] as const;

async function findSystemSystemdUnitPath(env: GatewayServiceEnv): Promise<string | null> {
  const serviceFile = `${resolveSystemdServiceName(env)}.service`;
  for (const dir of SYSTEM_SYSTEMD_UNIT_DIRS) {
    const candidate = path.posix.join(dir, serviceFile);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

type InstalledSystemdGatewayScope = {
  scope: SystemdUnitScope;
  unitName: string;
  unitPath: string;
};

async function findMarkerOwnedSystemSystemdUnit(): Promise<{
  unitName: string;
  unitPath: string;
} | null> {
  // System-scope installs may use non-canonical names; inspect marker-owned
  // units before declaring no installed service exists.
  const { findSystemGatewayServices } = await import("./inspect.js");
  let services: Awaited<ReturnType<typeof findSystemGatewayServices>>;
  try {
    services = await findSystemGatewayServices();
  } catch {
    return null;
  }
  for (const svc of services) {
    if (
      svc.platform !== "linux" ||
      svc.scope !== "system" ||
      svc.marker !== "openclaw" ||
      !svc.label?.endsWith(".service")
    ) {
      continue;
    }
    const match = /^unit:\s*(.+)$/.exec(svc.detail.trim());
    const unitPath = match?.[1]?.trim();
    if (unitPath) {
      return { unitName: svc.label, unitPath };
    }
  }
  return null;
}

export async function findInstalledSystemdGatewayScope(
  env: GatewayServiceEnv,
): Promise<InstalledSystemdGatewayScope | null> {
  const canonicalUnitName = `${resolveSystemdServiceName(env)}.service`;
  let userPath: string | null;
  try {
    userPath = resolveSystemdUnitPath(env);
  } catch {
    userPath = null;
  }
  if (userPath) {
    try {
      await fs.access(userPath);
      return { scope: "user", unitName: canonicalUnitName, unitPath: userPath };
    } catch {}
  }
  const systemPath = await findSystemSystemdUnitPath(env);
  if (systemPath) {
    return { scope: "system", unitName: canonicalUnitName, unitPath: systemPath };
  }
  const owned = await findMarkerOwnedSystemSystemdUnit();
  return owned ? { scope: "system", unitName: owned.unitName, unitPath: owned.unitPath } : null;
}

export { enableSystemdUserLinger, readSystemdUserLingerStatus };

// Unit file parsing/rendering: see systemd-unit.ts

export async function readSystemdServiceExecStart(
  env: GatewayServiceEnv,
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
        const parsed = parseSystemdEnvAssignment(raw);
        if (parsed) {
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
    const programArguments = parseSystemdExecStart(execStart);
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

function normalizeSystemdEnvironmentKey(key: string): string | null {
  return normalizeEnvVarKey(key, { portable: true })?.toUpperCase() ?? null;
}

function readSystemdEnvironmentValueSource(params: {
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
  key: string;
}): GatewayServiceEnvironmentValueSource | undefined {
  const normalizedKey = normalizeSystemdEnvironmentKey(params.key);
  if (!normalizedKey) {
    return undefined;
  }
  for (const [rawKey, source] of Object.entries(params.environmentValueSources ?? {})) {
    if (normalizeSystemdEnvironmentKey(rawKey) === normalizedKey) {
      return source;
    }
  }
  return undefined;
}

function collectSystemdInlineManagedKeys(params: {
  environment?: GatewayServiceEnv;
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
}): Set<string> {
  const keys = readManagedServiceEnvKeysFromEnvironment(params.environment);
  for (const key of collectSystemdFileManagedKeys({
    environmentValueSources: params.environmentValueSources,
  })) {
    keys.delete(key);
  }
  for (const [rawKey, value] of Object.entries(params.environment ?? {})) {
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    const key = normalizeSystemdEnvironmentKey(rawKey);
    if (!key) {
      continue;
    }
    const source = readSystemdEnvironmentValueSource({
      environmentValueSources: params.environmentValueSources,
      key: rawKey,
    });
    if (hasInlineEnvironmentSource(source) && !hasEnvironmentFileSource(source)) {
      keys.add(key);
    }
  }
  return keys;
}

function collectSystemdFileManagedKeys(params: {
  environmentValueSources?: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
}): Set<string> {
  const keys = new Set<string>();
  for (const [rawKey, source] of Object.entries(params.environmentValueSources ?? {})) {
    const key = normalizeSystemdEnvironmentKey(rawKey);
    if (key && isEnvironmentFileOnlySource(source)) {
      keys.add(key);
    }
  }
  return keys;
}

function collectSystemdFileBackedEnvironment(params: {
  environment?: GatewayServiceEnv;
  fileManagedKeys: ReadonlySet<string>;
}): Record<string, string> {
  if (params.fileManagedKeys.size === 0) {
    return {};
  }
  const environment: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(params.environment ?? {})) {
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      continue;
    }
    const key = normalizeSystemdEnvironmentKey(rawKey);
    if (key && params.fileManagedKeys.has(key) && !isUnresolvedShellReference(rawValue)) {
      environment[rawKey] = rawValue;
    }
  }
  return environment;
}

function sanitizeSystemdUnitBackupContent(params: {
  content: string;
  fileManagedKeys: ReadonlySet<string>;
}): string {
  if (params.fileManagedKeys.size === 0) {
    return params.content;
  }
  // Backups should not retain file-managed secrets that OpenClaw moved into the
  // generated EnvironmentFile during this rewrite.
  const sanitizedLines: string[] = [];
  for (const rawLine of params.content.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("Environment=")) {
      sanitizedLines.push(rawLine);
      continue;
    }
    const assignments = parseSystemdEnvAssignments(line.slice("Environment=".length).trim());
    if (assignments.length === 0) {
      sanitizedLines.push(rawLine);
      continue;
    }
    const keptAssignments = assignments.filter(({ key }) => {
      const normalizedKey = normalizeSystemdEnvironmentKey(key);
      return !normalizedKey || !params.fileManagedKeys.has(normalizedKey);
    });
    if (keptAssignments.length === assignments.length) {
      sanitizedLines.push(rawLine);
      continue;
    }
    if (keptAssignments.length === 0) {
      continue;
    }
    const leadingWhitespace = rawLine.match(/^\s*/)?.[0] ?? "";
    sanitizedLines.push(
      `${leadingWhitespace}Environment=${keptAssignments
        .map(({ key, value }) => renderSystemdEnvAssignment(key, value))
        .join(" ")}`,
    );
  }
  return sanitizedLines.join("\n");
}

function resolveSystemdEnvironmentFilePath(params: {
  stateDir: string;
  environment?: GatewayServiceEnv;
}): string {
  const serviceKind = params.environment?.OPENCLAW_SERVICE_KIND?.trim();
  const filename =
    serviceKind === "node" ? SYSTEMD_NODE_DOTENV_FILENAME : SYSTEMD_GATEWAY_DOTENV_FILENAME;
  return path.join(params.stateDir, filename);
}

function resolveLegacyNodeSystemdEnvironmentFilePath(params: {
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

function isNodeSystemdEnvironment(env: GatewayServiceEnv): boolean {
  return env.OPENCLAW_SERVICE_KIND?.trim() === "node";
}

function expandSystemdSpecifier(input: string, env: GatewayServiceEnv): string {
  // Support the common unit-specifier used in user services.
  return input.replaceAll("%h", toPosixPath(resolveHomeDir(env)));
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

function serializeSystemdEnvironmentFile(environment: Record<string, string>): string {
  return Object.entries(environment)
    .map(([key, value]) => `${key}=${serializeSystemdEnvironmentFileValue(value)}`)
    .join("\n");
}

async function readSystemdEnvironmentFile(pathname: string): Promise<{
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

type SystemdServiceInfo = {
  activeState?: string;
  subState?: string;
  mainPid?: number;
  execMainStatus?: number;
  execMainCode?: string;
  result?: string;
  nRestarts?: number;
  startLimitBurst?: number;
  unit?: string;
  killMode?: string;
  tasksCurrent?: number;
  memoryCurrent?: number;
};

export function parseSystemdShow(output: string): SystemdServiceInfo {
  const entries = parseKeyValueOutput(output, "=");
  const info: SystemdServiceInfo = {};
  const activeState = entries.activestate;
  if (activeState) {
    info.activeState = activeState;
  }
  const subState = entries.substate;
  if (subState) {
    info.subState = subState;
  }
  const mainPidValue = entries.mainpid;
  if (mainPidValue) {
    const pid = parseStrictPositiveInteger(mainPidValue);
    if (pid !== undefined) {
      info.mainPid = pid;
    }
  }
  const execMainStatusValue = entries.execmainstatus;
  if (execMainStatusValue) {
    const status = parseStrictInteger(execMainStatusValue);
    if (status !== undefined) {
      info.execMainStatus = status;
    }
  }
  const execMainCode = entries.execmaincode;
  if (execMainCode) {
    info.execMainCode = execMainCode;
  }
  const result = entries.result;
  if (result) {
    info.result = result;
  }
  const nRestartsValue = entries.nrestarts;
  if (nRestartsValue) {
    const nRestarts = parseStrictInteger(nRestartsValue);
    if (nRestarts !== undefined) {
      info.nRestarts = nRestarts;
    }
  }
  const startLimitBurstValue = entries.startlimitburst;
  if (startLimitBurstValue) {
    const startLimitBurst = parseStrictInteger(startLimitBurstValue);
    if (startLimitBurst !== undefined) {
      info.startLimitBurst = startLimitBurst;
    }
  }
  const unit = entries.id;
  if (unit) {
    info.unit = unit;
  }
  const killMode = entries.killmode;
  if (killMode) {
    info.killMode = killMode;
  }
  const tasksCurrentValue = entries.taskscurrent;
  if (tasksCurrentValue) {
    const tasksCurrent = parseStrictNonNegativeInteger(tasksCurrentValue);
    if (tasksCurrent !== undefined) {
      info.tasksCurrent = tasksCurrent;
    }
  }
  const memoryCurrentValue = entries.memorycurrent;
  if (memoryCurrentValue) {
    const memoryCurrent = parseStrictNonNegativeInteger(memoryCurrentValue);
    if (memoryCurrent !== undefined) {
      info.memoryCurrent = memoryCurrent;
    }
  }
  return info;
}

export type SystemdUnitScope = "system" | "user";

async function execSystemctl(
  args: string[],
  env?: GatewayServiceEnv,
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await execFileUtf8("systemctl", args, {
    env: env ? resolveSystemctlProcessEnv(env) : process.env,
    // A wedged systemd socket can leave `systemctl` blocked forever; the timeout
    // kills the child so status reads fail soft instead of hanging the command.
    ...(timeoutMs && timeoutMs > 0 ? { timeout: timeoutMs, killSignal: "SIGKILL" as const } : {}),
  });
}

function readSystemctlDetail(result: { stdout: string; stderr: string }): string {
  // Concatenate both streams so pattern matchers (isSystemdUnitNotEnabled,
  // isSystemctlMissing) can see the unit status from stdout even when
  // execFileUtf8 populates stderr with the Node error message fallback.
  return `${result.stderr} ${result.stdout}`.trim();
}

const isSystemctlMissing = isSystemctlMissingDetail;

function isSystemdUnitNotEnabled(detail: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return (
    normalized.includes("disabled") ||
    normalized.includes("static") ||
    normalized.includes("indirect") ||
    normalized.includes("masked") ||
    normalized.includes("not-found") ||
    normalized.includes("could not be found") ||
    normalized.includes("failed to get unit file state")
  );
}

function isSystemdUnitMissingDetail(detail: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return (
    (normalized.includes("unit file") && normalized.includes("does not exist")) ||
    normalized.includes("not-found") ||
    normalized.includes("could not be found")
  );
}

const isSystemctlBusUnavailable = isSystemdUserBusUnavailableDetail;

function isSystemdUserScopeUnavailable(detail: string): boolean {
  return classifySystemdUnavailableDetail(detail) !== null;
}

function isGenericSystemctlIsEnabledFailure(detail: string): boolean {
  if (!detail) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return (
    normalized.startsWith("command failed: systemctl") &&
    normalized.includes(" is-enabled ") &&
    !normalized.includes("permission denied") &&
    !normalized.includes("access denied") &&
    !normalized.includes("no space left") &&
    !normalized.includes("read-only file system") &&
    !normalized.includes("out of memory") &&
    !normalized.includes("cannot allocate memory")
  );
}

export function isNonFatalSystemdInstallProbeError(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!detail) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(detail);
  return isSystemctlBusUnavailable(normalized) || isGenericSystemctlIsEnabledFailure(normalized);
}

function resolveSystemctlDirectUserScopeArgs(): string[] {
  return ["--user"];
}

function readSystemctlEnvUser(env: GatewayServiceEnv): string | null {
  return env.USER?.trim() || env.LOGNAME?.trim() || null;
}

function readSystemctlEffectiveUser(): string | null {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

function readSystemctlEffectiveUid(): number | null {
  if (typeof process.geteuid !== "function") {
    return null;
  }
  try {
    return process.geteuid();
  } catch {
    return null;
  }
}

function resolveSystemctlProcessEnv(env: GatewayServiceEnv): NodeJS.ProcessEnv {
  const processEnv = { ...process.env, ...env };
  if (processEnv.XDG_RUNTIME_DIR?.trim() && processEnv.DBUS_SESSION_BUS_ADDRESS?.trim()) {
    return processEnv;
  }

  const uid = readSystemctlEffectiveUid();
  if (uid === null || uid === 0) {
    return processEnv;
  }

  const runtimeDir = processEnv.XDG_RUNTIME_DIR?.trim() || `/run/user/${uid}`;
  const busPath = path.posix.join(runtimeDir, "bus");
  if (!fsSync.existsSync(busPath)) {
    return processEnv;
  }

  // In non-login shells the bus socket can exist while DBUS_SESSION_BUS_ADDRESS
  // is missing. Fill it so systemctl --user reaches the right user manager.
  return {
    ...processEnv,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: processEnv.DBUS_SESSION_BUS_ADDRESS?.trim() || `unix:path=${busPath}`,
  };
}

function isNonRootUser(user: string | null): user is string {
  return Boolean(user && user !== "root");
}

function hasRootUserManagerEnvironment(env: GatewayServiceEnv): boolean {
  const home = env.HOME?.trim();
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  const dbusAddress = env.DBUS_SESSION_BUS_ADDRESS?.trim();
  return (
    home === "/root" &&
    runtimeDir === "/run/user/0" &&
    Boolean(dbusAddress?.includes("/run/user/0/bus"))
  );
}

function resolveSystemctlUserScope(env: GatewayServiceEnv): {
  machineUser: string | null;
  preferMachineScope: boolean;
} {
  const sudoUser = env.SUDO_USER?.trim() || null;
  const envUser = readSystemctlEnvUser(env);
  const effectiveUid = readSystemctlEffectiveUid();
  const effectiveUser = readSystemctlEffectiveUser();
  const isEffectiveRoot = effectiveUid === null ? effectiveUser === "root" : effectiveUid === 0;
  const hasRootUserManager = isEffectiveRoot && hasRootUserManagerEnvironment(env);
  const isSudoToRoot = isEffectiveRoot && !hasRootUserManager && isNonRootUser(sudoUser);
  const machineUser = hasRootUserManager
    ? null
    : isSudoToRoot
      ? sudoUser
      : isNonRootUser(envUser)
        ? envUser
        : isNonRootUser(sudoUser)
          ? sudoUser
          : effectiveUser || envUser || sudoUser || null;
  return {
    machineUser,
    preferMachineScope: isSudoToRoot,
  };
}

function resolveSystemctlMachineUserScopeArgs(user: string): string[] {
  const trimmedUser = user.trim();
  if (!trimmedUser) {
    return [];
  }
  return ["--machine", `${trimmedUser}@`, "--user"];
}

function shouldFallbackToMachineUserScope(detail: string): boolean {
  if (!isSystemdUserBusUnavailableDetail(detail)) {
    return false;
  }
  // "Permission denied" means the bus socket exists but this process cannot connect to it.
  // The machine-scope approach targets the same bus infrastructure and will also fail,
  // so do not trigger the fallback in this case.
  return !detail.toLowerCase().includes("permission denied");
}

async function execSystemctlUser(
  env: GatewayServiceEnv,
  args: string[],
  timeoutMs?: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { machineUser, preferMachineScope } = resolveSystemctlUserScope(env);

  // Under sudo-to-root, prefer the invoking non-root user's scope directly via machine scope.
  if (preferMachineScope && machineUser) {
    const machineScopeArgs = resolveSystemctlMachineUserScopeArgs(machineUser);
    if (machineScopeArgs.length > 0) {
      // Do not fall through to bare --user: under sudo that can target root's user manager.
      return await execSystemctl([...machineScopeArgs, ...args], env, timeoutMs);
    }
  }

  const directResult = await execSystemctl(
    [...resolveSystemctlDirectUserScopeArgs(), ...args],
    env,
    timeoutMs,
  );
  if (directResult.code === 0) {
    return directResult;
  }

  const detail = `${directResult.stderr} ${directResult.stdout}`.trim();
  if (!machineUser || !shouldFallbackToMachineUserScope(detail)) {
    return directResult;
  }

  const machineScopeArgs = resolveSystemctlMachineUserScopeArgs(machineUser);
  if (machineScopeArgs.length === 0) {
    return directResult;
  }
  return await execSystemctl([...machineScopeArgs, ...args], env, timeoutMs);
}

export async function isSystemdUserServiceAvailable(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
): Promise<boolean> {
  const res = await execSystemctlUser(env, ["status"]);
  if (res.code === 0) {
    return true;
  }
  const detail = `${res.stderr} ${res.stdout}`.trim();
  if (!detail) {
    return false;
  }
  return !isSystemdUserScopeUnavailable(detail);
}

export async function isSystemdUnitActive(
  env: GatewayServiceEnv,
  unitName: string,
  scope: SystemdUnitScope = "user",
): Promise<boolean> {
  const normalizedUnit = unitName.trim();
  if (!normalizedUnit) {
    return false;
  }
  const args = ["is-active", "--quiet", normalizedUnit];
  const res = scope === "system" ? await execSystemctl(args) : await execSystemctlUser(env, args);
  return res.code === 0;
}

async function assertSystemdAvailable(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
  timeoutMs?: number,
) {
  const res = await execSystemctlUser(env, ["status"], timeoutMs);
  if (res.code === 0) {
    return;
  }
  const detail = readSystemctlDetail(res);
  if (isSystemctlMissing(detail)) {
    throw new Error("systemctl not available; systemd user services are required on Linux.");
  }
  if (!detail) {
    throw new Error("systemctl --user unavailable: unknown error");
  }
  if (!isSystemdUserScopeUnavailable(detail)) {
    return;
  }
  throw new Error(`systemctl --user unavailable: ${detail || "unknown error"}`.trim());
}

async function writeSystemdUnit({
  env,
  programArguments,
  workingDirectory,
  environment,
  environmentValueSources,
  description,
}: Omit<GatewayServiceInstallArgs, "stdout">): Promise<{ unitPath: string; backedUp: boolean }> {
  await assertSystemdAvailable(env);

  const unitPath = resolveSystemdUnitPath(env);
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  const fileManagedKeys = collectSystemdFileManagedKeys({
    environmentValueSources,
  });

  // Preserve user customizations: back up existing unit file before overwriting.
  let backedUp = false;
  try {
    const backupPath = `${unitPath}.bak`;
    const existingUnit = await fs.readFile(unitPath, "utf8");
    const existingStat = await fs.stat(unitPath);
    const backupMode = existingStat.mode & 0o777 || 0o600;
    const backupUnit = sanitizeSystemdUnitBackupContent({
      content: existingUnit,
      fileManagedKeys,
    });
    await fs.writeFile(backupPath, backupUnit, { encoding: "utf8", mode: backupMode });
    await fs.chmod(backupPath, backupMode);
    backedUp = true;
  } catch {
    // File does not exist yet — nothing to back up.
  }

  const serviceDescription = resolveGatewayServiceDescription({ env, environment, description });
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  const { entries: stateDirDotEnvEntries, skippedShellReferenceKeys } =
    readStateDirDotEnvFromStateDir(stateDir);
  const stateDirDotEnvVars = Object.fromEntries(
    Object.entries(stateDirDotEnvEntries).filter(([key, value]) => {
      const inlineValue = environment?.[key];
      if (typeof inlineValue !== "string") {
        return true;
      }
      return inlineValue.trim() === value.trim();
    }),
  );
  const inlineManagedKeys = collectSystemdInlineManagedKeys({
    environment,
    environmentValueSources,
  });
  const environmentFileResult = await writeSystemdGatewayEnvironmentFile({
    stateDir,
    dotenvVars: stateDirDotEnvVars,
    inlineManagedKeys,
    fileManagedKeys,
    skippedManagedKeys: skippedShellReferenceKeys,
    fileBackedEnvironment: collectSystemdFileBackedEnvironment({
      environment,
      fileManagedKeys,
    }),
    environment,
  });
  const environmentSansDotEnvEntries = Object.fromEntries(
    Object.entries(environment ?? {}).filter(([key, value]) => {
      if (typeof value !== "string") {
        return false;
      }
      const source = readSystemdEnvironmentValueSource({
        environmentValueSources,
        key,
      });
      if (hasEnvironmentFileSource(source) && isUnresolvedShellReference(value)) {
        return false;
      }
      const normalizedKey = normalizeSystemdEnvironmentKey(key);
      if (
        normalizedKey &&
        environmentFileResult.environmentKeys.has(normalizedKey) &&
        !inlineManagedKeys.has(normalizedKey)
      ) {
        return false;
      }
      const stateDirValue = stateDirDotEnvVars[key];
      if (typeof stateDirValue !== "string") {
        return true;
      }
      return value.trim() !== stateDirValue.trim();
    }),
  );
  const unit = buildSystemdUnit({
    description: serviceDescription,
    programArguments,
    workingDirectory,
    environment: environmentSansDotEnvEntries,
    environmentFiles: environmentFileResult.environmentFiles,
  });
  await fs.writeFile(unitPath, unit, "utf8");
  return { unitPath, backedUp };
}

async function writeSystemdGatewayEnvironmentFile(params: {
  stateDir: string;
  dotenvVars: Record<string, string>;
  /** OpenClaw-managed keys that must not be preserved from an old env file; stale file values
   *  would override fresh inline Environment= entries because EnvironmentFile takes precedence. */
  inlineManagedKeys?: ReadonlySet<string>;
  /** File-managed keys that should be written from current environment values or removed when absent. */
  fileManagedKeys?: ReadonlySet<string>;
  /** State-dir .env keys OpenClaw previously managed but is now skipping (unresolved shell
   *  references). A prior re-stage may have written a stale literal value for them; drop it so
   *  the regenerated env file no longer carries the obsolete reference. */
  skippedManagedKeys?: Iterable<string>;
  fileBackedEnvironment?: Record<string, string>;
  environment?: GatewayServiceEnv;
}): Promise<{ environmentFiles: string[]; environmentKeys: Set<string> }> {
  const incoming = { ...params.dotenvVars, ...params.fileBackedEnvironment };
  for (const [key, value] of Object.entries(incoming)) {
    if (/[\r\n]/.test(value)) {
      throw new Error(
        `state-dir .env contains a multiline value for ${key}; systemd EnvironmentFile values must be single-line`,
      );
    }
  }
  const envFilePath = resolveSystemdEnvironmentFilePath({
    stateDir: params.stateDir,
    environment: params.environment,
  });

  // Read existing env files first so we can preserve operator-added secrets
  // (e.g. provider API keys) across upgrades and re-stages. Node units used
  // to share gateway.systemd.env, so migrate those entries into node.systemd.env.
  // OpenClaw-managed keys (identified by inlineManagedKeys) are excluded: a stale
  // file copy would override the fresh inline Environment= value because systemd's
  // EnvironmentFile takes precedence over inline Environment= directives.
  const existing: Record<string, string> = {};
  const literalShellReferenceKeys = new Set<string>();
  const legacyNodeEnvFilePath = resolveLegacyNodeSystemdEnvironmentFilePath({
    stateDir: params.stateDir,
    environment: params.environment,
  });
  for (const sourceEnvFilePath of [legacyNodeEnvFilePath, envFilePath]) {
    if (!sourceEnvFilePath) {
      continue;
    }
    try {
      const fromFile = await readSystemdEnvironmentFile(sourceEnvFilePath);
      for (const [key, value] of Object.entries(fromFile.environment)) {
        existing[key] = value;
        if (fromFile.literalShellReferenceKeys.has(key)) {
          literalShellReferenceKeys.add(key);
        } else {
          literalShellReferenceKeys.delete(key);
        }
      }
    } catch {
      // File does not exist yet — nothing to preserve.
    }
  }
  const managedKeysToDrop = new Set([
    ...(params.inlineManagedKeys ?? []),
    ...(params.fileManagedKeys ?? []),
    ...[...(params.skippedManagedKeys ?? [])].flatMap((key) => {
      const normalized = normalizeSystemdEnvironmentKey(key);
      return normalized ? [normalized] : [];
    }),
  ]);
  const operatorOnly = Object.fromEntries(
    Object.entries(existing).filter(([key, value]) => {
      const normalized = normalizeSystemdEnvironmentKey(key);
      if (normalized && managedKeysToDrop.has(normalized)) {
        return false;
      }
      // Quoting or escaping `$VAR` records operator intent; bare references can
      // still be stale values copied from the state-dir dotenv file.
      return literalShellReferenceKeys.has(key) || !isUnresolvedShellReference(value);
    }),
  );
  const merged = { ...operatorOnly, ...incoming };
  const environmentKeys = new Set(
    Object.keys(merged).flatMap((key) => {
      const normalized = normalizeSystemdEnvironmentKey(key);
      return normalized ? [normalized] : [];
    }),
  );

  // If the merged result is empty there is nothing to write and no file needed.
  if (Object.keys(merged).length === 0) {
    await fs.rm(envFilePath, { force: true }).catch(() => undefined);
    return { environmentFiles: [], environmentKeys };
  }

  const content = serializeSystemdEnvironmentFile(merged);
  await fs.mkdir(path.dirname(envFilePath), { recursive: true });
  await fs.writeFile(envFilePath, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(envFilePath, 0o600);
  return { environmentFiles: [envFilePath], environmentKeys };
}

async function removeNodeSystemdManagedEnvironmentKeys(env: GatewayServiceEnv): Promise<void> {
  if (!isNodeSystemdEnvironment(env)) {
    return;
  }
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  const envFilePath = resolveSystemdEnvironmentFilePath({
    stateDir,
    environment: env,
  });
  let existingFile: Awaited<ReturnType<typeof readSystemdEnvironmentFile>>;
  try {
    existingFile = await readSystemdEnvironmentFile(envFilePath);
  } catch {
    return;
  }
  const managedKeys = new Set(["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"]);
  const remaining = Object.fromEntries(
    Object.entries(existingFile.environment).filter(([key, value]) => {
      const normalized = normalizeSystemdEnvironmentKey(key);
      if (normalized && managedKeys.has(normalized)) {
        return false;
      }
      return existingFile.literalShellReferenceKeys.has(key) || !isUnresolvedShellReference(value);
    }),
  );
  if (Object.keys(remaining).length === 0) {
    await fs.rm(envFilePath, { force: true });
    return;
  }
  const content = serializeSystemdEnvironmentFile(remaining);
  await fs.writeFile(envFilePath, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(envFilePath, 0o600);
}

export async function stageSystemdService({
  stdout,
  ...args
}: GatewayServiceInstallArgs): Promise<{ unitPath: string }> {
  const { unitPath, backedUp } = await writeSystemdUnit(args);
  writeFormattedLines(
    stdout,
    [
      {
        label: "Staged systemd service",
        value: unitPath,
      },
      ...(backedUp
        ? [
            {
              label: "Previous unit backed up to",
              value: `${unitPath}.bak`,
            },
          ]
        : []),
    ],
    { leadingBlankLine: true },
  );
  return { unitPath };
}

async function activateSystemdService(params: { env: GatewayServiceEnv }) {
  const serviceName = resolveSystemdServiceName(params.env);
  const unitName = `${serviceName}.service`;
  const reloadSystemd = async () => await execSystemctlUser(params.env, ["daemon-reload"]);
  const throwActivationFailure = (
    action: "daemon-reload" | "enable" | "restart",
    result: { stdout: string; stderr: string },
  ): never => {
    const detail = readSystemctlDetail(result);
    if (isSystemdUserScopeUnavailable(detail)) {
      throw new Error(`systemctl --user unavailable: ${detail || "unknown error"}`.trim());
    }
    throw new Error(`systemctl ${action} failed: ${detail || "unknown error"}`.trim());
  };
  const reload = await reloadSystemd();
  if (reload.code !== 0) {
    throwActivationFailure("daemon-reload", reload);
  }

  const runAfterReloadRetry = async (action: "enable" | "restart") => {
    const result = await execSystemctlUser(params.env, [action, unitName]);
    if (result.code === 0 || !isSystemdUnitMissingDetail(readSystemctlDetail(result))) {
      return result;
    }
    const retryReload = await reloadSystemd();
    if (retryReload.code !== 0) {
      throwActivationFailure("daemon-reload", retryReload);
    }
    return await execSystemctlUser(params.env, [action, unitName]);
  };

  const enable = await runAfterReloadRetry("enable");
  if (enable.code !== 0) {
    throwActivationFailure("enable", enable);
  }

  const restart = await runAfterReloadRetry("restart");
  if (restart.code !== 0) {
    throwActivationFailure("restart", restart);
  }
}

export async function installSystemdService(
  args: GatewayServiceInstallArgs,
): Promise<{ unitPath: string }> {
  const { unitPath, backedUp } = await writeSystemdUnit(args);
  await activateSystemdService({ env: args.env });
  writeFormattedLines(
    args.stdout,
    [
      {
        label: "Installed systemd service",
        value: unitPath,
      },
      ...(backedUp
        ? [
            {
              label: "Previous unit backed up to",
              value: `${unitPath}.bak`,
            },
          ]
        : []),
    ],
    { leadingBlankLine: true },
  );
  return { unitPath };
}

export async function uninstallSystemdService({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<void> {
  await assertSystemdAvailable(env);
  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;
  await execSystemctlUser(env, ["disable", "--now", unitName]);

  const unitPath = resolveSystemdUnitPath(env);
  let removed = false;
  try {
    await fs.unlink(unitPath);
    removed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // Unit file was already absent; still clean generated node env state below.
  }
  await removeNodeSystemdManagedEnvironmentKeys(env);
  if (removed) {
    stdout.write(`${formatLine("Removed systemd service", unitPath)}\n`);
  } else {
    stdout.write(`Systemd service not found at ${unitPath}\n`);
  }
}

function isRunningAsRoot(): boolean {
  if (typeof process.geteuid === "function") {
    try {
      return process.geteuid() === 0;
    } catch {
      return false;
    }
  }
  return false;
}

async function runSystemdServiceAction(params: {
  stdout: NodeJS.WritableStream;
  env?: GatewayServiceEnv;
  action: "stop" | "restart";
  label: string;
}) {
  const env = params.env ?? process.env;
  const installed = await findInstalledSystemdGatewayScope(env);
  const unitName = installed?.unitName ?? `${resolveSystemdServiceName(env)}.service`;
  if (installed?.scope === "system") {
    if (!isRunningAsRoot()) {
      throw new Error(
        `${unitName} is a system-scope unit (${installed.unitPath}); run \`sudo systemctl ${params.action} ${unitName}\` to ${params.action} it`,
      );
    }
    if (params.action === "restart") {
      // systemd latches a unit into failed/start-limit-hit after it crashes faster
      // than StartLimitBurst allows and then stops auto-restarting it. Clear the
      // latch first so an operator restart can recover a crash-looped gateway;
      // reset-failed is idempotent and a no-op on a healthy unit.
      await execSystemctl(["reset-failed", unitName], env);
    }
    const res = await execSystemctl([params.action, unitName], env);
    if (res.code !== 0) {
      throw new Error(`systemctl ${params.action} failed: ${res.stderr || res.stdout}`.trim());
    }
    params.stdout.write(`${formatLine(params.label, unitName)}\n`);
    return;
  }
  await assertSystemdAvailable(env);
  if (params.action === "restart") {
    // Clear any failed/start-limit-hit latch before restart so a crash-looped
    // gateway recovers (see system-scope branch above). Idempotent on healthy units.
    await execSystemctlUser(env, ["reset-failed", unitName]);
  }
  const res = await execSystemctlUser(env, [params.action, unitName]);
  if (res.code !== 0) {
    throw new Error(`systemctl ${params.action} failed: ${res.stderr || res.stdout}`.trim());
  }
  params.stdout.write(`${formatLine(params.label, unitName)}\n`);
}

export async function stopSystemdService({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<void> {
  await runSystemdServiceAction({
    stdout,
    env,
    action: "stop",
    label: "Stopped systemd service",
  });
}

export async function restartSystemdService({
  stdout,
  env,
}: GatewayServiceControlArgs): Promise<GatewayServiceRestartResult> {
  await runSystemdServiceAction({
    stdout,
    env,
    action: "restart",
    label: "Restarted systemd service",
  });
  return { outcome: "completed" };
}

export async function isSystemdServiceEnabled(args: GatewayServiceEnvArgs): Promise<boolean> {
  const env = args.env ?? process.env;
  const installed = await findInstalledSystemdGatewayScope(env);
  if (!installed) {
    return false;
  }
  const res =
    installed.scope === "system"
      ? await execSystemctl(["is-enabled", installed.unitName], env, args.timeoutMs)
      : await execSystemctlUser(env, ["is-enabled", installed.unitName], args.timeoutMs);
  if (res.code === 0) {
    return true;
  }
  const detail = readSystemctlDetail(res);
  if (isSystemctlMissing(detail) || isSystemdUnitNotEnabled(detail)) {
    return false;
  }
  throw new Error(`systemctl is-enabled unavailable: ${detail || "unknown error"}`.trim());
}

export async function readSystemdServiceRuntime(
  env: GatewayServiceEnv = process.env as GatewayServiceEnv,
  opts?: GatewayServiceReadOptions,
): Promise<GatewayServiceRuntime> {
  const timeoutMs = opts?.timeoutMs;
  const installed = await findInstalledSystemdGatewayScope(env).catch(() => null);
  if (installed?.scope !== "system") {
    try {
      await assertSystemdAvailable(env, timeoutMs);
    } catch (err) {
      return {
        status: "unknown",
        detail: formatErrorMessage(err),
      };
    }
  }
  const unitName = installed?.unitName ?? `${resolveSystemdServiceName(env)}.service`;
  const showArgs = [
    "show",
    unitName,
    "--no-page",
    "--property",
    "Id,ActiveState,SubState,Result,NRestarts,StartLimitBurst,MainPID,ExecMainStatus,ExecMainCode,KillMode,TasksCurrent,MemoryCurrent",
  ];
  const res =
    installed?.scope === "system"
      ? await execSystemctl(showArgs, env, timeoutMs)
      : await execSystemctlUser(env, showArgs, timeoutMs);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    const missing = normalizeLowercaseStringOrEmpty(detail).includes("not found");
    return {
      status: missing ? "stopped" : "unknown",
      detail: detail || undefined,
      missingUnit: missing,
    };
  }
  const parsed = parseSystemdShow(res.stdout || "");
  const activeState = normalizeLowercaseStringOrEmpty(parsed.activeState);
  const status = activeState === "active" ? "running" : activeState ? "stopped" : "unknown";
  return {
    status,
    state: parsed.activeState,
    subState: parsed.subState,
    pid: parsed.mainPid,
    lastExitStatus: parsed.execMainStatus,
    lastExitReason: parsed.execMainCode,
    systemd: {
      unit: parsed.unit ?? unitName,
      killMode: parsed.killMode,
      tasksCurrent: parsed.tasksCurrent,
      memoryCurrent: parsed.memoryCurrent,
      result: parsed.result,
      nRestarts: parsed.nRestarts,
      startLimitBurst: parsed.startLimitBurst,
    },
  };
}
type LegacySystemdUnit = {
  name: string;
  unitPath: string;
  enabled: boolean;
  exists: boolean;
};

async function isSystemctlAvailable(env: GatewayServiceEnv): Promise<boolean> {
  const res = await execSystemctlUser(env, ["status"]);
  if (res.code === 0) {
    return true;
  }
  return !isSystemctlMissing(readSystemctlDetail(res));
}

async function findLegacySystemdUnits(env: GatewayServiceEnv): Promise<LegacySystemdUnit[]> {
  const results: LegacySystemdUnit[] = [];
  const systemctlAvailable = await isSystemctlAvailable(env);
  for (const name of LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
    const unitPath = resolveSystemdUnitPathForName(env, name);
    let exists = false;
    try {
      await fs.access(unitPath);
      exists = true;
    } catch {
      // ignore
    }
    let enabled = false;
    if (systemctlAvailable) {
      const res = await execSystemctlUser(env, ["is-enabled", `${name}.service`]);
      enabled = res.code === 0;
    }
    if (exists || enabled) {
      results.push({ name, unitPath, enabled, exists });
    }
  }
  return results;
}

export async function uninstallLegacySystemdUnits({
  env,
  stdout,
}: GatewayServiceManageArgs): Promise<LegacySystemdUnit[]> {
  const units = await findLegacySystemdUnits(env);
  if (units.length === 0) {
    return units;
  }

  const systemctlAvailable = await isSystemctlAvailable(env);
  for (const unit of units) {
    if (systemctlAvailable) {
      await execSystemctlUser(env, ["disable", "--now", `${unit.name}.service`]);
    } else {
      stdout.write(`systemctl unavailable; removed legacy unit file only: ${unit.name}.service\n`);
    }

    try {
      await fs.unlink(unit.unitPath);
      stdout.write(`${formatLine("Removed legacy systemd service", unit.unitPath)}\n`);
    } catch {
      stdout.write(`Legacy systemd unit not found at ${unit.unitPath}\n`);
    }
  }

  return units;
}
