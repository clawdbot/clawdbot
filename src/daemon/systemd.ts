import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { readStateDirDotEnvVarsFromStateDir } from "../config/state-dir-dotenv.js";
import { formatErrorMessage } from "../infra/errors.js";
import { parseStrictInteger, parseStrictPositiveInteger } from "../infra/parse-finite-number.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
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
import type { GatewayServiceRuntime } from "./service-runtime.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceControlArgs,
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceEnvironmentValueSource,
  GatewayServiceInstallArgs,
  GatewayServiceManageArgs,
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
  parseSystemdExecStart,
} from "./systemd-unit.js";

const SYSTEMD_GATEWAY_DOTENV_FILENAME = "gateway.systemd.env";

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

function expandSystemdSpecifier(input: string, env: GatewayServiceEnv): string {
  // Support the common unit-specifier used in user services.
  return input.replaceAll("%h", toPosixPath(resolveHomeDir(env)));
}

function parseEnvironmentFileSpecs(raw: string): string[] {
  return splitArgsPreservingQuotes(raw, { escapeMode: "backslash" })
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseEnvironmentFileLine(rawLine: string): { key: string; value: string } | null {
  const trimmed = rawLine.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
    return null;
  }
  const eq = trimmed.indexOf("=");
  if (eq <= 0) {
    return null;
  }
  const key = trimmed.slice(0, eq).trim();
  if (!key) {
    return null;
  }
  let value = trimmed.slice(eq + 1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

async function readSystemdEnvironmentFile(pathname: string): Promise<Record<string, string>> {
  const environment: Record<string, string> = {};
  const content = await fs.readFile(pathname, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const parsed = parseEnvironmentFileLine(rawLine);
    if (!parsed) {
      continue;
    }
    environment[parsed.key] = parsed.value;
  }
  return environment;
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
        Object.assign(resolved, fromFile);
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
  return info;
}

export type SystemdUnitScope = "system" | "user";

async function execSystemctl(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await execFileUtf8("systemctl", args);
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

function isNonRootUser(user: string | null): user is string {
  return Boolean(user && user !== "root");
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
  const isSudoToRoot = isEffectiveRoot && isNonRootUser(sudoUser);
  const machineUser = isSudoToRoot
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
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { machineUser, preferMachineScope } = resolveSystemctlUserScope(env);

  // Under sudo-to-root, prefer the invoking non-root user's scope directly via machine scope.
  if (preferMachineScope && machineUser) {
    const machineScopeArgs = resolveSystemctlMachineUserScopeArgs(machineUser);
    if (machineScopeArgs.length > 0) {
      // Do not fall through to bare --user: under sudo that can target root's user manager.
      return await execSystemctl([...machineScopeArgs, ...args]);
    }
  }

  const directResult = await execSystemctl([...resolveSystemctlDirectUserScopeArgs(), ...args]);
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
  return await execSystemctl([...machineScopeArgs, ...args]);
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

async function assertSystemdAvailable(env: GatewayServiceEnv = process.env as GatewayServiceEnv) {
  const res = await execSystemctlUser(env, ["status"]);
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
  description,
}: Omit<GatewayServiceInstallArgs, "stdout">): Promise<{ unitPath: string; backedUp: boolean }> {
  await assertSystemdAvailable(env);

  const unitPath = resolveSystemdUnitPath(env);
  await fs.mkdir(path.dirname(unitPath), { recursive: true });

  // Preserve user customizations: back up existing unit file before overwriting.
  let backedUp = false;
  try {
    await fs.access(unitPath);
    const backupPath = `${unitPath}.bak`;
    await fs.copyFile(unitPath, backupPath);
    backedUp = true;
  } catch {
    // File does not exist yet — nothing to back up.
  }

  const serviceDescription = resolveGatewayServiceDescription({ env, environment, description });
  const stateDir = resolveStateDir(env as NodeJS.ProcessEnv);
  const stateDirDotEnvVars = Object.fromEntries(
    Object.entries(readStateDirDotEnvVarsFromStateDir(stateDir)).filter(([key, value]) => {
      const inlineValue = environment?.[key];
      if (typeof inlineValue !== "string") {
        return true;
      }
      return inlineValue.trim() === value.trim();
    }),
  );
  const environmentFiles = await writeSystemdGatewayEnvironmentFile({
    stateDir,
    dotenvVars: stateDirDotEnvVars,
  });
  const environmentSansDotEnvEntries = Object.fromEntries(
    Object.entries(environment ?? {}).filter(([key, value]) => {
      if (typeof value !== "string") {
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
    environmentFiles,
  });
  await fs.writeFile(unitPath, unit, "utf8");
  return { unitPath, backedUp };
}

async function writeSystemdGatewayEnvironmentFile(params: {
  stateDir: string;
  dotenvVars: Record<string, string>;
}): Promise<string[]> {
  const entries = Object.entries(params.dotenvVars);
  if (entries.length === 0) {
    return [];
  }
  for (const [key, value] of entries) {
    if (/[\r\n]/.test(value)) {
      throw new Error(
        `state-dir .env contains a multiline value for ${key}; systemd EnvironmentFile values must be single-line`,
      );
    }
  }
  const envFilePath = path.join(params.stateDir, SYSTEMD_GATEWAY_DOTENV_FILENAME);
  const content = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  await fs.writeFile(envFilePath, `${content}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(envFilePath, 0o600);
  return [envFilePath];
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
  try {
    await fs.unlink(unitPath);
    stdout.write(`${formatLine("Removed systemd service", unitPath)}\n`);
  } catch {
    stdout.write(`Systemd service not found at ${unitPath}\n`);
  }
}

async function runSystemdServiceAction(params: {
  stdout: NodeJS.WritableStream;
  env?: GatewayServiceEnv;
  action: "stop" | "restart";
  label: string;
}) {
  const env = params.env ?? process.env;
  await assertSystemdAvailable(env);
  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;
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
  try {
    await fs.access(resolveSystemdUnitPath(env));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }

  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;
  const res = await execSystemctlUser(env, ["is-enabled", unitName]);
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
): Promise<GatewayServiceRuntime> {
  try {
    await assertSystemdAvailable(env);
  } catch (err) {
    return {
      status: "unknown",
      detail: formatErrorMessage(err),
    };
  }
  const serviceName = resolveSystemdServiceName(env);
  const unitName = `${serviceName}.service`;
  const res = await execSystemctlUser(env, [
    "show",
    unitName,
    "--no-page",
    "--property",
    "ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode",
  ]);
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
