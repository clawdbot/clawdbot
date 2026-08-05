/** Detects system-domain launchd ownership before mutating a user LaunchAgent. */
import fs from "node:fs/promises";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { execFileUtf8 } from "./exec-file.js";
import {
  execLaunchctl,
  formatLaunchctlResultDetail,
  isLaunchctlNotLoaded,
  type LaunchctlResult,
} from "./launchd-exec.js";

const SYSTEM_LAUNCH_DAEMON_DIR = "/Library/LaunchDaemons";
const PLUTIL_PATH = "/usr/bin/plutil";

type SystemLaunchDaemonOwnership =
  | { status: "absent"; serviceTarget: string }
  | { status: "loaded"; serviceTarget: string }
  | { status: "installed"; serviceTarget: string; plistPath: string }
  | {
      status: "unverifiable";
      serviceTarget: string;
      operation: "launchctl" | "filesystem";
      detail: string;
    };

type SystemLaunchDaemonConflict = Exclude<SystemLaunchDaemonOwnership, { status: "absent" }>;

function formatUnknownError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return truncateUtf16Safe(sanitizeForLog(raw), 500);
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function quotePosixArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Renders the package-independent ownership probe used by detached restart helpers.
 * The caller must refuse activation when `openclaw_system_launchd_conflict` is non-empty.
 */
export function renderSystemLaunchDaemonOwnershipShellProbe(label: string): string {
  const serviceTarget = `system/${label}`;
  return `openclaw_system_launchd_conflict=""
openclaw_system_launchd_detail=""
openclaw_system_launchd_target=${quotePosixArgument(serviceTarget)}
openclaw_system_launchd_dir=${quotePosixArgument(SYSTEM_LAUNCH_DAEMON_DIR)}
openclaw_system_launchd_label=${quotePosixArgument(label)}
openclaw_system_launchd_probe=$(launchctl print "$openclaw_system_launchd_target" 2>&1)
openclaw_system_launchd_probe_status=$?
if [ "$openclaw_system_launchd_probe_status" -eq 0 ]; then
  openclaw_system_launchd_conflict="$openclaw_system_launchd_target"
  openclaw_system_launchd_detail="loaded system LaunchDaemon $openclaw_system_launchd_target"
elif ! printf '%s' "$openclaw_system_launchd_probe" | /usr/bin/grep -Eiq 'could not find service|no such process|not found'; then
  openclaw_system_launchd_conflict="$openclaw_system_launchd_target"
  openclaw_system_launchd_detail="could not verify $openclaw_system_launchd_target: $openclaw_system_launchd_probe"
fi
if [ -z "$openclaw_system_launchd_conflict" ]; then
  if [ ! -e "$openclaw_system_launchd_dir" ]; then
    :
  elif [ ! -r "$openclaw_system_launchd_dir" ] || [ ! -x "$openclaw_system_launchd_dir" ]; then
    openclaw_system_launchd_conflict="$openclaw_system_launchd_dir"
    openclaw_system_launchd_detail="could not inspect $openclaw_system_launchd_dir"
  else
    openclaw_system_launchd_entries=""
    if openclaw_system_launchd_entries=$(/usr/bin/mktemp "\${TMPDIR:-/tmp}/openclaw-launchd-scan.XXXXXX" 2>&1); then
      if /usr/bin/find "$openclaw_system_launchd_dir" -mindepth 1 -maxdepth 1 -name '*.plist' -print0 >"$openclaw_system_launchd_entries"; then
        while IFS= read -r -d '' openclaw_system_launchd_plist; do
          if openclaw_system_launchd_plist_label=$(/usr/bin/plutil -extract Label raw -o - -- "$openclaw_system_launchd_plist" 2>&1); then
            if [ "$openclaw_system_launchd_plist_label" != "$openclaw_system_launchd_label" ]; then
              continue
            fi
            openclaw_system_launchd_conflict="$openclaw_system_launchd_plist"
            openclaw_system_launchd_detail="installed same-label system LaunchDaemon plist $openclaw_system_launchd_plist"
            break
          elif /usr/bin/plutil -lint -- "$openclaw_system_launchd_plist" >/dev/null 2>&1; then
            continue
          else
            openclaw_system_launchd_conflict="$openclaw_system_launchd_plist"
            openclaw_system_launchd_detail="could not inspect system LaunchDaemon plist $openclaw_system_launchd_plist: $openclaw_system_launchd_plist_label"
            break
          fi
        done <"$openclaw_system_launchd_entries"
      else
        openclaw_system_launchd_conflict="$openclaw_system_launchd_dir"
        openclaw_system_launchd_detail="could not enumerate $openclaw_system_launchd_dir"
      fi
      /bin/rm -f "$openclaw_system_launchd_entries"
    else
      openclaw_system_launchd_conflict="$openclaw_system_launchd_dir"
      openclaw_system_launchd_detail="could not create a secure system LaunchDaemon scan snapshot: $openclaw_system_launchd_entries"
    fi
  fi
fi
if [ -z "$openclaw_system_launchd_conflict" ]; then
  openclaw_system_launchd_probe=$(launchctl print "$openclaw_system_launchd_target" 2>&1)
  openclaw_system_launchd_probe_status=$?
  if [ "$openclaw_system_launchd_probe_status" -eq 0 ]; then
    openclaw_system_launchd_conflict="$openclaw_system_launchd_target"
    openclaw_system_launchd_detail="loaded system LaunchDaemon $openclaw_system_launchd_target"
  elif ! printf '%s' "$openclaw_system_launchd_probe" | /usr/bin/grep -Eiq 'could not find service|no such process|not found'; then
    openclaw_system_launchd_conflict="$openclaw_system_launchd_target"
    openclaw_system_launchd_detail="could not verify $openclaw_system_launchd_target: $openclaw_system_launchd_probe"
  fi
fi
`;
}

type LaunchDaemonPlistLabelResult =
  | { status: "ok"; label: string }
  | { status: "unlabeled" }
  | { status: "missing" }
  | { status: "unverifiable"; detail: string };

/** Reads the top-level Label through the native parser for XML and binary plists. */
export async function readLaunchDaemonPlistLabel(
  plistPath: string,
): Promise<LaunchDaemonPlistLabelResult> {
  const converted = await execFileUtf8(PLUTIL_PATH, [
    "-convert",
    "json",
    "-o",
    "-",
    "--",
    plistPath,
  ]);
  if (converted.code === 0) {
    try {
      const plist = JSON.parse(converted.stdout) as { Label?: unknown } | null;
      const label = plist?.Label;
      return typeof label === "string" && label.length > 0
        ? { status: "ok", label }
        : { status: "unlabeled" };
    } catch (error) {
      return { status: "unverifiable", detail: formatUnknownError(error) };
    }
  }
  try {
    await fs.access(plistPath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { status: "missing" };
    }
    return { status: "unverifiable", detail: formatUnknownError(error) };
  }
  return {
    status: "unverifiable",
    detail: formatLaunchctlResultDetail(converted) || "plutil could not decode the plist",
  };
}

type InstalledSystemLaunchDaemonScan =
  | { status: "absent" }
  | { status: "installed"; plistPath: string }
  | { status: "unverifiable"; detail: string };

async function findInstalledSystemLaunchDaemon(
  label: string,
): Promise<InstalledSystemLaunchDaemonScan> {
  let entries: string[];
  try {
    entries = await fs.readdir(SYSTEM_LAUNCH_DAEMON_DIR);
  } catch (error) {
    if (isMissingPathError(error)) {
      return { status: "absent" };
    }
    return { status: "unverifiable", detail: formatUnknownError(error) };
  }

  for (const entry of entries.filter((candidate) => candidate.endsWith(".plist")).toSorted()) {
    const plistPath = path.posix.join(SYSTEM_LAUNCH_DAEMON_DIR, entry);
    const result = await readLaunchDaemonPlistLabel(plistPath);
    if (result.status === "ok" && result.label === label) {
      return { status: "installed", plistPath };
    }
    if (result.status === "unverifiable") {
      return { status: "unverifiable", detail: `${plistPath}: ${result.detail}` };
    }
  }
  return { status: "absent" };
}

function classifySystemLaunchDaemonQuery(
  serviceTarget: string,
  result: LaunchctlResult,
): SystemLaunchDaemonOwnership {
  if (result.code === 0) {
    return { status: "loaded", serviceTarget };
  }
  return isLaunchctlNotLoaded(result)
    ? { status: "absent", serviceTarget }
    : {
        status: "unverifiable",
        serviceTarget,
        operation: "launchctl",
        detail: formatLaunchctlResultDetail(result) || `exit code ${result.code}`,
      };
}

export async function inspectSystemLaunchDaemonOwnership(
  label: string,
  options: { scanInstalledPlists?: boolean } = {},
): Promise<SystemLaunchDaemonOwnership> {
  const serviceTarget = `system/${label}`;
  if (process.platform !== "darwin") {
    return { status: "absent", serviceTarget };
  }

  const initialQuery = classifySystemLaunchDaemonQuery(
    serviceTarget,
    await execLaunchctl(["print", serviceTarget]),
  );
  if (initialQuery.status !== "absent") {
    return initialQuery;
  }
  if (options.scanInstalledPlists === false) {
    return { status: "absent", serviceTarget };
  }

  const installed = await findInstalledSystemLaunchDaemon(label);
  if (installed.status === "installed") {
    return { status: "installed", serviceTarget, plistPath: installed.plistPath };
  }
  if (installed.status === "unverifiable") {
    return {
      status: "unverifiable",
      serviceTarget,
      operation: "filesystem",
      detail: installed.detail,
    };
  }
  // Close the query-to-directory-snapshot race at the last responsible moment.
  // Arbitrary root installers cannot share a lock with this unprivileged process;
  // activation paths therefore repeat this complete probe immediately before use.
  return classifySystemLaunchDaemonQuery(
    serviceTarget,
    await execLaunchctl(["print", serviceTarget]),
  );
}

export function formatSystemLaunchDaemonOwnershipSummary(
  ownership: SystemLaunchDaemonConflict,
): string {
  switch (ownership.status) {
    case "loaded":
      return `System LaunchDaemon ${ownership.serviceTarget} already owns this gateway label.`;
    case "installed":
      return `System LaunchDaemon plist ${ownership.plistPath} already owns this gateway label.`;
    case "unverifiable":
      return `System LaunchDaemon ownership for ${ownership.serviceTarget} could not be verified: ${ownership.detail}`;
    default: {
      const exhaustive: never = ownership;
      throw new Error(`Unexpected system LaunchDaemon ownership: ${String(exhaustive)}`);
    }
  }
}

function formatSystemLaunchDaemonOwnershipError(ownership: SystemLaunchDaemonConflict): string {
  const recovery =
    ownership.status === "loaded"
      ? `Keep it as the sole gateway manager, or unload it with \`sudo launchctl bootout ${ownership.serviceTarget}\` and remove its plist before retrying.`
      : ownership.status === "installed"
        ? `Keep it as the sole gateway manager, or remove or relocate ${quotePosixArgument(ownership.plistPath)} before retrying.`
        : "Fix the reported launchctl or filesystem access error, then retry.";
  return [
    formatSystemLaunchDaemonOwnershipSummary(ownership),
    "Refusing to create or activate a user LaunchAgent for the same label because duplicate KeepAlive managers can restart-loop the gateway.",
    "OpenClaw does not manage system LaunchDaemons, and --force does not override system ownership.",
    recovery,
  ].join("\n");
}

class SystemLaunchDaemonOwnershipError extends Error {
  readonly code = "SYSTEM_LAUNCH_DAEMON_OWNERSHIP";

  constructor(readonly ownership: SystemLaunchDaemonConflict) {
    super(formatSystemLaunchDaemonOwnershipError(ownership));
    this.name = "SystemLaunchDaemonOwnershipError";
  }
}

export function isSystemLaunchDaemonOwnershipError(
  error: unknown,
): error is SystemLaunchDaemonOwnershipError {
  return error instanceof SystemLaunchDaemonOwnershipError;
}

export async function assertNoSystemLaunchDaemonOwnership(label: string): Promise<void> {
  const ownership = await inspectSystemLaunchDaemonOwnership(label);
  if (ownership.status !== "absent") {
    // System-domain ownership is host-wide. A gui-domain manager with the same
    // label can create two independent KeepAlive loops for one gateway port.
    throw new SystemLaunchDaemonOwnershipError(ownership);
  }
}
