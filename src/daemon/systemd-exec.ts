/** systemctl execution, user-manager routing, and availability probes. */
import * as fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { escapeRegExp } from "../shared/regexp.js";
import { execFileUtf8 } from "./exec-file.js";
import type { GatewayServiceEnv } from "./service-types.js";
import {
  classifySystemdUnavailableDetail,
  isSystemctlMissingDetail,
  isSystemdUserBusUnavailableDetail,
} from "./systemd-unavailable.js";

export type SystemdUnitScope = "system" | "user";

export async function execSystemctl(
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

export function readSystemctlDetail(result: { stdout: string; stderr: string }): string {
  // Concatenate both streams so pattern matchers (isSystemdUnitNotEnabled,
  // isSystemctlMissing) can see the unit status from stdout even when
  // execFileUtf8 populates stderr with the Node error message fallback.
  return `${result.stderr} ${result.stdout}`.trim();
}

export const isSystemctlMissing = isSystemctlMissingDetail;

export function isSystemdUnitNotEnabled(detail: string): boolean {
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

export function isSystemdUnitMissingDetail(detail: string): boolean {
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

function isSystemdUnitAlreadyMissingOrInactive(detail: string, unitName: string): boolean {
  const escapedUnitName = escapeRegExp(normalizeLowercaseStringOrEmpty(unitName));
  return new RegExp(
    `^(?:failed to (?:disable unit|stop\\s+${escapedUnitName}):\\s*)?` +
      `(?:unit file\\s+${escapedUnitName}\\s+does not exist|` +
      `unit\\s+${escapedUnitName}(?:\\s+is)?\\s+` +
      `(?:inactive|not\\s+active|not\\s+loaded|not-found|could not be found))[.!]?$`,
    "u",
  ).test(normalizeLowercaseStringOrEmpty(detail));
}

const isSystemctlBusUnavailable = isSystemdUserBusUnavailableDetail;

export function isSystemdUserScopeUnavailable(detail: string): boolean {
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

/**
 * Resolves the account whose user manager owns the service operation.
 * Keep linger diagnostics on this identity so sudo never checks root while
 * systemctl targets the invoking user's manager.
 */
export function resolveSystemdUserServiceAccount(env: GatewayServiceEnv): string | null {
  const { machineUser } = resolveSystemctlUserScope(env);
  return machineUser ?? readSystemctlEffectiveUser() ?? readSystemctlEnvUser(env);
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

export async function execSystemctlUser(
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

export async function disableSystemdUserUnitForRemoval(
  env: GatewayServiceEnv,
  unitName: string,
): Promise<void> {
  const result = await execSystemctlUser(env, ["disable", "--now", unitName]);
  if (result.code === 0) {
    return;
  }
  const detail = readSystemctlDetail(result);
  if (isSystemdUnitAlreadyMissingOrInactive(detail, unitName)) {
    return;
  }
  throw new Error(`systemctl disable failed: ${detail || "unknown error"}`);
}

export async function reloadSystemdUserManager(env: GatewayServiceEnv): Promise<void> {
  const result = await execSystemctlUser(env, ["daemon-reload"]);
  if (result.code !== 0) {
    throw new Error(
      `systemctl daemon-reload failed: ${readSystemctlDetail(result) || "unknown error"}`,
    );
  }
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

export async function assertSystemdAvailable(
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

export async function isSystemctlAvailable(env: GatewayServiceEnv): Promise<boolean> {
  const res = await execSystemctlUser(env, ["status"]);
  if (res.code === 0) {
    return true;
  }
  return !isSystemctlMissing(readSystemctlDetail(res));
}
