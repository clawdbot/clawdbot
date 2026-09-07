/** Detects system-scope systemd ownership before mutating a user gateway unit. */
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { isMissingPathError } from "../infra/errors.js";
import { execBusctlSystem, execSystemctl, readSystemctlDetail } from "./systemd-exec.js";

type SystemSystemdOwnership =
  | { status: "absent"; unitName: string }
  | { status: "loaded"; unitName: string }
  | { status: "installed"; unitName: string; unitPath: string }
  | {
      status: "unverifiable";
      unitName: string;
      operation: "systemctl" | "busctl" | "filesystem";
      detail: string;
    };

type SystemSystemdConflict = Exclude<SystemSystemdOwnership, { status: "absent" }>;

function formatUnknownError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return truncateUtf16Safe(sanitizeForLog(raw), 500);
}

function quotePosixArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function unverifiableSystemOwnership(
  unitName: string,
  detail: string,
  operation: "systemctl" | "busctl" | "filesystem" = "systemctl",
): SystemSystemdOwnership {
  return { status: "unverifiable", unitName, operation, detail };
}

async function querySystemManager(
  unitName: string,
  run = execSystemctl,
): Promise<SystemSystemdOwnership> {
  const result = await run(["show", "--property=LoadState", "--value", unitName]);
  const loadState = result.stdout.trim().toLowerCase();
  if (result.code === 0) {
    if (loadState === "not-found") {
      return { status: "absent", unitName };
    }
    if (loadState) {
      return { status: "loaded", unitName };
    }
    return unverifiableSystemOwnership(unitName, "systemctl returned no LoadState");
  }
  const detail = readSystemctlDetail(result) || `systemctl exited with code ${result.code}`;
  const normalizedDetail = detail.toLowerCase();
  if (
    result.termination === "exit" &&
    normalizedDetail.includes(unitName.toLowerCase()) &&
    /not[- ]found|could not be found/i.test(normalizedDetail)
  ) {
    return { status: "absent", unitName };
  }
  return unverifiableSystemOwnership(unitName, detail);
}

async function findInstalledSystemUnit(
  unitName: string,
  run = execSystemctl,
): Promise<SystemSystemdOwnership> {
  const result = await run(["show", "--property=UnitPath", "--value"]);
  if (result.code !== 0) {
    const detail = readSystemctlDetail(result) || `systemctl exited with code ${result.code}`;
    return unverifiableSystemOwnership(unitName, detail);
  }
  const loadPaths = [...new Set(result.stdout.split(/\s+/).filter(path.posix.isAbsolute))];
  if (loadPaths.length === 0) {
    return unverifiableSystemOwnership(
      unitName,
      "systemctl returned no system manager unit load paths",
    );
  }
  return await findInstalledSystemUnitInPaths(unitName, loadPaths);
}

async function findInstalledSystemUnitInPaths(
  unitName: string,
  loadPaths: readonly string[],
): Promise<SystemSystemdOwnership> {
  for (const dir of loadPaths) {
    const unitPath = path.posix.join(dir, unitName);
    try {
      await fs.lstat(unitPath);
      return { status: "installed", unitName, unitPath };
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      const detail = `${unitPath}: ${formatUnknownError(error)}`;
      return unverifiableSystemOwnership(unitName, detail, "filesystem");
    }
  }
  return { status: "absent", unitName };
}

/** Do not activate a system manager or load a unit during update admission. */
async function inspectLoadedSystemOwnership(
  unitName: string,
  timeoutMs?: number,
): Promise<SystemSystemdOwnership> {
  const manager = "org.freedesktop.systemd1";
  const bus = "org.freedesktop.DBus";
  const missingUnit = Symbol("affirmative native absence");
  const deadline =
    performance.now() +
    (timeoutMs && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000);
  const unavailable = () => new Error("Non-loading system manager inspection unavailable.");
  const query = async (
    args: string[],
    signature: string,
    allowMissing = false,
  ): Promise<unknown> => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw unavailable();
    }
    const result = await execBusctlSystem(["--auto-start=no", "--json=short", ...args], remaining);
    if (result.termination !== "exit" || performance.now() >= deadline) {
      throw unavailable();
    }
    if (result.code !== 0) {
      if (
        allowMissing &&
        [
          `Call failed: Unit ${unitName} not loaded.`,
          `Call failed: Unit ${unitName} not found.`,
        ].includes(result.stderr.trim())
      ) {
        return missingUnit;
      }
      throw unavailable();
    }
    const parsed = asOptionalRecord(JSON.parse(result.stdout));
    if (parsed?.type !== signature) {
      throw unavailable();
    }
    return parsed.data;
  };
  const readOwner = async () => {
    const value = await query(
      ["call", bus, "/org/freedesktop/DBus", bus, "GetNameOwner", "s", manager],
      "s",
    );
    if (
      !Array.isArray(value) ||
      value.length !== 1 ||
      typeof value[0] !== "string" ||
      !/^:[0-9]+\.[0-9]+$/.test(value[0])
    ) {
      throw unavailable();
    }
    return value[0];
  };
  try {
    if (path.posix.basename(unitName) !== unitName) {
      throw unavailable();
    }
    const owner = await readOwner();
    const readLoaded = async () => {
      const value = await query(
        [
          "call",
          owner,
          "/org/freedesktop/systemd1",
          `${manager}.Manager`,
          "GetUnit",
          "s",
          unitName,
        ],
        "o",
        true,
      );
      if (value === missingUnit) {
        return false;
      }
      if (
        !Array.isArray(value) ||
        value.length !== 1 ||
        typeof value[0] !== "string" ||
        !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(value[0])
      ) {
        throw unavailable();
      }
      return true;
    };
    if (await readLoaded()) {
      return { status: "loaded", unitName };
    }
    const paths = await query(
      ["get-property", owner, "/org/freedesktop/systemd1", `${manager}.Manager`, "UnitPath"],
      "as",
    );
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      !paths.every(
        (entry): entry is string =>
          typeof entry === "string" && path.posix.isAbsolute(entry) && !entry.includes("\0"),
      )
    ) {
      throw unavailable();
    }
    const installed = await findInstalledSystemUnitInPaths(unitName, [...new Set(paths)]);
    if (installed.status !== "absent") {
      return installed;
    }
    if (await readLoaded()) {
      return { status: "loaded", unitName };
    }
    if (owner !== (await readOwner())) {
      throw unavailable();
    }
    return { status: "absent", unitName };
  } catch (error) {
    return unverifiableSystemOwnership(unitName, formatUnknownError(error), "busctl");
  }
}

async function inspectSystemSystemdOwnership(
  unitName: string,
  timeoutMs?: number,
  options?: { requireLoaded?: boolean },
): Promise<SystemSystemdOwnership> {
  if (process.platform !== "linux") {
    return { status: "absent", unitName };
  }

  if (options?.requireLoaded) {
    return await inspectLoadedSystemOwnership(unitName, timeoutMs);
  }

  const deadline = timeoutMs && timeoutMs > 0 ? performance.now() + timeoutMs : undefined;
  const remaining = () => (deadline ? Math.max(1, deadline - performance.now()) : undefined);
  const run = (args: string[]) => execSystemctl(args, undefined, remaining());
  const initialQuery = await querySystemManager(unitName, run);
  if (initialQuery.status !== "absent") {
    return initialQuery;
  }
  const installed = await findInstalledSystemUnit(unitName, run);
  if (installed.status !== "absent") {
    return installed;
  }
  // Close the manager-query-to-filesystem-snapshot race. Publication and
  // activation repeat the complete probe because root installers share no lock.
  return await querySystemManager(unitName, run);
}

function isRunningAsRoot(): boolean {
  if (typeof process.geteuid !== "function") {
    return false;
  }
  try {
    return process.geteuid() === 0;
  } catch {
    return false;
  }
}

function formatSystemSystemdOwnershipError(ownership: SystemSystemdConflict): string {
  const privilegePrefix = isRunningAsRoot() ? "" : "sudo ";
  const unitName = quotePosixArgument(ownership.unitName);
  const summary =
    ownership.status === "loaded"
      ? `System systemd unit ${ownership.unitName} already owns this gateway unit name.`
      : ownership.status === "installed"
        ? `System systemd unit ${ownership.unitPath} already owns this gateway unit name.`
        : `System systemd ownership for ${ownership.unitName} could not be verified: ${ownership.detail}`;
  const installedInAdministratorPath =
    ownership.status === "installed" &&
    (ownership.unitPath.startsWith("/etc/systemd/system/") ||
      ownership.unitPath.startsWith("/etc/systemd/system.control/"));
  const recovery =
    ownership.status === "loaded"
      ? `Keep it as the sole gateway manager, or inspect it with \`${privilegePrefix}systemctl cat ${unitName}\`, then disable it and uninstall or reconfigure the package, generator, or administrator unit that owns it before retrying.`
      : installedInAdministratorPath
        ? `Keep it as the sole gateway manager, or run \`${privilegePrefix}systemctl disable --now ${unitName}\`, \`${privilegePrefix}rm ${quotePosixArgument(ownership.unitPath)}\`, and \`${privilegePrefix}systemctl daemon-reload\` before retrying.`
        : ownership.status === "installed"
          ? `Keep it as the sole gateway manager, or inspect it with \`${privilegePrefix}systemctl cat ${unitName}\`, then uninstall or reconfigure the package, generator, or runtime owner of ${quotePosixArgument(ownership.unitPath)} before retrying.`
          : "Fix the reported systemctl or filesystem access error, then retry.";
  return [
    summary,
    "Refusing to create or activate a user systemd unit with the same name because duplicate managers can restart-loop the gateway.",
    "OpenClaw does not manage system-scope units, and --force does not override system ownership.",
    recovery,
  ].join("\n");
}

class SystemSystemdOwnershipError extends Error {
  readonly code = "SYSTEM_SYSTEMD_OWNERSHIP";

  constructor(readonly ownership: SystemSystemdConflict) {
    super(formatSystemSystemdOwnershipError(ownership));
    this.name = "SystemSystemdOwnershipError";
  }
}

export function isSystemSystemdOwnershipError(
  error: unknown,
): error is SystemSystemdOwnershipError {
  return error instanceof SystemSystemdOwnershipError;
}

export async function assertNoSystemSystemdOwnership(
  unitName: string,
  timeoutMs?: number,
  options?: { requireLoaded?: boolean },
): Promise<void> {
  const ownership = await inspectSystemSystemdOwnership(unitName, timeoutMs, options);
  if (ownership.status !== "absent") {
    throw new SystemSystemdOwnershipError(ownership);
  }
}
