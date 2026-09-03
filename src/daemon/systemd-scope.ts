/** Installed systemd scope discovery and dueling-manager diagnostics. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { hasErrnoCode } from "../infra/errno.js";
import { isGatewayServiceEnv } from "./constants.js";
import { resolveDaemonHomeDir } from "./paths.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { execSystemctl, isSystemdUnitActive, type SystemdUnitScope } from "./systemd-exec.js";
import { resolveSystemdServiceName, resolveSystemdUnitPath } from "./systemd-service-files.js";
import { assertNoSystemSystemdOwnership } from "./systemd-system.js";

const SYSTEM_SYSTEMD_UNIT_DIRS = [
  "/etc/systemd/system",
  "/usr/lib/systemd/system",
  "/lib/systemd/system",
] as const;

/** Proves service absence without interpreting failed manager commands as absence. */
export async function isSystemdServiceAbsent(env: GatewayServiceEnv): Promise<boolean> {
  if (
    env.DBUS_SESSION_BUS_ADDRESS ||
    env.DBUS_SYSTEM_BUS_ADDRESS ||
    env.SYSTEMD_UNIT_PATH ||
    env.SUDO_USER ||
    isGatewayServiceEnv(env) ||
    typeof process.geteuid !== "function"
  ) {
    return false;
  }
  const home = resolveDaemonHomeDir(env);
  const runtimeDirs = new Set(
    [`/run/user/${process.geteuid()}`, env.XDG_RUNTIME_DIR].filter((value): value is string =>
      Boolean(value),
    ),
  );
  const configHome = env.XDG_CONFIG_HOME || path.posix.join(home, ".config");
  const dataHome = env.XDG_DATA_HOME || path.posix.join(home, ".local/share");
  const userRoots = [
    path.posix.join(home, ".config"),
    configHome,
    dataHome,
    ...(env.XDG_CONFIG_DIRS || "/etc/xdg").split(":"),
    ...(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
    "/etc",
    "/usr/local/lib",
    "/usr/lib",
    "/lib",
  ];
  const unitName = `${resolveSystemdServiceName(env)}.service`;
  if (![...runtimeDirs, ...userRoots].every((dir) => path.posix.isAbsolute(dir))) {
    return false;
  }
  // sd_booted() uses /run/systemd/system; user managers own runtime/systemd/private.
  // Require the complete runtime directory absent so transient/generated units cannot hide.
  const absentPaths = [
    "/run/systemd",
    ...[...runtimeDirs].map((dir) => path.posix.join(dir, "systemd")),
    ...userRoots.flatMap((dir) =>
      ["user", "user.control", "user.attached"].map((scope) =>
        path.posix.join(dir, "systemd", scope, unitName),
      ),
    ),
    ...["/etc", "/usr/local/lib", "/usr/lib", "/lib"].flatMap((dir) =>
      ["system", "system.control", "system.attached"].map((scope) =>
        path.posix.join(dir, "systemd", scope, unitName),
      ),
    ),
  ];
  for (const candidate of absentPaths) {
    try {
      await fs.lstat(candidate);
      return false;
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        return false;
      }
    }
  }
  return (await findInstalledSystemdGatewayScope(env)) === null;
}

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

export async function assertNoSystemGatewayOwnership(
  env: GatewayServiceEnv,
  timeoutMs?: number,
): Promise<void> {
  if (env.OPENCLAW_SERVICE_KIND?.trim() === "node") {
    return;
  }
  await assertNoSystemSystemdOwnership(`${resolveSystemdServiceName(env)}.service`, timeoutMs);
}

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

/**
 * The full installed-gateway picture across both systemd scopes.
 *
 * Modeled as a discriminated union so the "both a user-scope and a
 * system-scope unit are installed" (`dueling`) state is representable and
 * cannot be confused with the single-scope states. The old single-scope
 * detector could never surface this, which is the root cause of the
 * upgrade restart cascade in issue #79375: two supervisors bind the same
 * port and SIGTERM each other forever.
 */
type SystemdGatewayInstallation =
  | { kind: "none" }
  | { kind: "user"; user: InstalledSystemdGatewayScope }
  | { kind: "system"; system: InstalledSystemdGatewayScope }
  | {
      kind: "dueling";
      user: InstalledSystemdGatewayScope;
      system: InstalledSystemdGatewayScope;
    };

async function findUserSystemdGatewayScope(
  env: GatewayServiceEnv,
): Promise<InstalledSystemdGatewayScope | null> {
  const canonicalUnitName = `${resolveSystemdServiceName(env)}.service`;
  let userPath: string | null;
  try {
    userPath = resolveSystemdUnitPath(env);
  } catch {
    userPath = null;
  }
  if (!userPath) {
    return null;
  }
  try {
    await fs.access(userPath);
    return { scope: "user", unitName: canonicalUnitName, unitPath: userPath };
  } catch {
    return null;
  }
}

async function findSystemSystemdGatewayScope(
  env: GatewayServiceEnv,
): Promise<InstalledSystemdGatewayScope | null> {
  const canonicalUnitName = `${resolveSystemdServiceName(env)}.service`;
  const systemPath = await findSystemSystemdUnitPath(env);
  if (systemPath) {
    return { scope: "system", unitName: canonicalUnitName, unitPath: systemPath };
  }
  // System-scope installs may use a non-canonical unit name; fall back to a
  // marker-owned lookup before declaring no system unit exists.
  const owned = await findMarkerOwnedSystemSystemdUnit();
  return owned ? { scope: "system", unitName: owned.unitName, unitPath: owned.unitPath } : null;
}

/**
 * Canonical detector: reports every installed scope without early-returning,
 * so a coexisting user + system unit surfaces as `dueling`.
 */
export async function findSystemdGatewayInstallation(
  env: GatewayServiceEnv,
): Promise<SystemdGatewayInstallation> {
  const [user, system] = await Promise.all([
    findUserSystemdGatewayScope(env),
    findSystemSystemdGatewayScope(env),
  ]);
  if (user && system) {
    // Only the SAME canonical gateway installed in both scopes is a dueling
    // conflict (issue #79375). A marker-owned system unit with a *different*
    // name is an intentional separate gateway — e.g. a rescue bot on the same
    // host (see docs: /gateway#multiple-gateways-same-host) — and must never
    // be treated as a duplicate of the user unit, or doctor could remove a
    // legitimate user gateway. The user unit is always canonical; the direct
    // system path is canonical too, so the real #79375 case still matches.
    if (user.unitName === system.unitName) {
      return { kind: "dueling", user, system };
    }
    return { kind: "user", user };
  }
  if (user) {
    return { kind: "user", user };
  }
  if (system) {
    return { kind: "system", system };
  }
  return { kind: "none" };
}

/**
 * The single scope to act on, preserving the long-standing user-first
 * preference its four lifecycle callers (stop/restart/is-enabled/runtime)
 * rely on. Dueling resolution (removing the redundant user unit) is handled
 * separately by doctor via {@link findSystemdGatewayInstallation}; this
 * function intentionally does not change lifecycle semantics.
 */
export async function findInstalledSystemdGatewayScope(
  env: GatewayServiceEnv,
): Promise<InstalledSystemdGatewayScope | null> {
  const installation = await findSystemdGatewayInstallation(env);
  // User-first: dueling resolves to the user scope, same as a user-only install.
  if (installation.kind === "dueling" || installation.kind === "user") {
    return installation.user;
  }
  if (installation.kind === "system") {
    return installation.system;
  }
  return null;
}

/**
 * True only when the system-scope unit is running now AND persistently enabled
 * at boot. Doctor's dueling repair deletes the user unit behind this probe, so
 * both halves are required: an enabled-but-failed unit would leave no gateway
 * until the next boot, and an active-but-unenabled unit would leave none after
 * it. Uncheckable (systemctl missing/erroring) reads as false so the repair
 * fails closed to hints rather than removing a working user-scope gateway.
 */
export async function isSystemUnitActiveAndEnabled(
  env: GatewayServiceEnv,
  unitName: string,
): Promise<boolean> {
  const active = await isSystemdUnitActive(env, unitName, "system");
  if (!active.ok || !active.value) {
    return false;
  }
  const res = await execSystemctl(["is-enabled", unitName], env);
  if (res.code !== 0) {
    return false;
  }
  // `is-enabled` also exits 0 for enabled-runtime, alias, static, indirect,
  // generated, and transient (systemctl(1) Table 3). Only a plain `enabled`
  // symlink survives a reboot, so anything else must not authorize deleting
  // the user unit.
  return normalizeLowercaseStringOrEmpty(res.stdout) === "enabled";
}

/**
 * Builds the operator-facing warning for a `dueling` installation, or null for
 * any other state. Pure (no I/O) so the startup guard's messaging is unit
 * testable without faking the whole service-mode boot path.
 */
export function formatDuelingScopesWarning(
  installation: SystemdGatewayInstallation,
  port: number,
): string | null {
  if (installation.kind !== "dueling") {
    return null;
  }
  const { user, system } = installation;
  // Deliberately no copy-paste removal command: this formatter has no ownership
  // evidence, and blindly deleting the user unit can remove the only working
  // gateway. `doctor --fix` decides that behind the active+enabled probe.
  return (
    `detected BOTH a user-scope (${user.unitPath}) and a system-scope (${system.unitPath}) ` +
    `gateway unit bound to port ${port}; they will SIGTERM each other in a restart loop. ` +
    `Run \`openclaw doctor --fix\` to resolve which unit should own this gateway.`
  );
}
