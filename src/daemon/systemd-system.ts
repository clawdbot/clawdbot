/** Detects system-scope systemd ownership before mutating a user gateway unit. */
import fs from "node:fs/promises";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { execFileUtf8 } from "./exec-file.js";

type SystemSystemdOwnership =
  | { status: "absent"; unitName: string }
  | { status: "loaded"; unitName: string }
  | { status: "installed"; unitName: string; unitPath: string }
  | {
      status: "unverifiable";
      unitName: string;
      operation: "systemctl" | "filesystem";
      detail: string;
    };

type SystemSystemdConflict = Exclude<SystemSystemdOwnership, { status: "absent" }>;

function formatUnknownError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return truncateUtf16Safe(sanitizeForLog(raw), 500);
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function quotePosixArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

async function querySystemManager(unitName: string): Promise<SystemSystemdOwnership> {
  const result = await execFileUtf8("systemctl", [
    "show",
    "--property=LoadState",
    "--value",
    unitName,
  ]);
  const loadState = result.stdout.trim().toLowerCase();
  if (result.code === 0) {
    if (loadState === "not-found") {
      return { status: "absent", unitName };
    }
    if (loadState) {
      return { status: "loaded", unitName };
    }
    return {
      status: "unverifiable",
      unitName,
      operation: "systemctl",
      detail: "systemctl returned no LoadState",
    };
  }
  const detail = `${result.stderr} ${result.stdout}`.trim();
  const normalizedDetail = detail.toLowerCase();
  if (
    normalizedDetail.includes(unitName.toLowerCase()) &&
    /not[- ]found|could not be found/i.test(normalizedDetail)
  ) {
    return { status: "absent", unitName };
  }
  return {
    status: "unverifiable",
    unitName,
    operation: "systemctl",
    detail: detail || `systemctl exited with code ${result.code}`,
  };
}

async function readSystemUnitLoadPaths(
  unitName: string,
): Promise<string[] | SystemSystemdOwnership> {
  const result = await execFileUtf8("systemctl", ["show", "--property=UnitPath", "--value"]);
  if (result.code !== 0) {
    const detail = `${result.stderr} ${result.stdout}`.trim();
    return {
      status: "unverifiable",
      unitName,
      operation: "systemctl",
      detail: detail || `systemctl exited with code ${result.code}`,
    };
  }
  const paths = [
    ...new Set(
      result.stdout
        .split(/\s+/)
        .map((entry) => entry.trim())
        .filter((entry) => path.posix.isAbsolute(entry)),
    ),
  ];
  if (paths.length === 0) {
    return {
      status: "unverifiable",
      unitName,
      operation: "systemctl",
      detail: "systemctl returned no system manager unit load paths",
    };
  }
  return paths;
}

async function findInstalledSystemUnit(unitName: string): Promise<SystemSystemdOwnership> {
  const loadPaths = await readSystemUnitLoadPaths(unitName);
  if (!Array.isArray(loadPaths)) {
    return loadPaths;
  }
  for (const dir of loadPaths) {
    const unitPath = path.posix.join(dir, unitName);
    try {
      await fs.lstat(unitPath);
      return { status: "installed", unitName, unitPath };
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      return {
        status: "unverifiable",
        unitName,
        operation: "filesystem",
        detail: `${unitPath}: ${formatUnknownError(error)}`,
      };
    }
  }
  return { status: "absent", unitName };
}

async function inspectSystemSystemdOwnership(unitName: string): Promise<SystemSystemdOwnership> {
  if (process.platform !== "linux") {
    return { status: "absent", unitName };
  }

  const initialQuery = await querySystemManager(unitName);
  if (initialQuery.status !== "absent") {
    return initialQuery;
  }
  const installed = await findInstalledSystemUnit(unitName);
  if (installed.status !== "absent") {
    return installed;
  }
  // Close the manager-query-to-filesystem-snapshot race. Publication and
  // activation repeat the complete probe because root installers share no lock.
  return await querySystemManager(unitName);
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

export async function assertNoSystemSystemdOwnership(unitName: string): Promise<void> {
  const ownership = await inspectSystemSystemdOwnership(unitName);
  if (ownership.status !== "absent") {
    throw new SystemSystemdOwnershipError(ownership);
  }
}
