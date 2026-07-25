import { execFileSync } from "node:child_process";
import path from "node:path";

type ReadinessDeps = {
  execFileSync: typeof execFileSync;
};

const DEFAULT_DEPS: ReadinessDeps = { execFileSync };

function resolveWindowsSystemExecutable(name: string): string {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  return path.win32.join(systemRoot || "C:\\Windows", "System32", name);
}

// The IsoEnvBroker service is demand-started, so it does not need to be RUNNING
// at plugin load: we only require that it is installed. `sc.exe query` exits
// non-zero (1060) when the service is absent, which surfaces as a thrown error;
// a successful query means the service exists and Windows will start it on use.
function assertWindowsIsoEnvBrokerInstalled(deps: ReadinessDeps): void {
  try {
    deps.execFileSync(resolveWindowsSystemExecutable("sc.exe"), ["query", "IsoEnvBroker"], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5_000,
      windowsHide: true,
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message.trim()}` : "";
    throw new Error(
      `[mxc] MXC Windows ProcessContainer sandbox is not ready: IsoEnvBroker service is not installed${detail}. ` +
        `Install the IsoEnvBroker service before enabling MXC sandbox execution.`,
      { cause: error },
    );
  }
}

// AppContainer processes need directory-traversal/list rights on the system
// drive root (C:\) to enumerate directories inside the sandbox.
// `wxc-host-prep prepare-system-drive` adds ACEs for the well-known
// ALL APPLICATION PACKAGES (S-1-15-2-1) and ALL RESTRICTED APPLICATION PACKAGES
// (S-1-15-2-2) SIDs. Without this, directory listing (e.g. `dir`) inside the
// sandbox fails with "Access is denied". This is advisory: the sandbox still
// runs basic cmd.exe read/write workloads without it, so a missing grant warns
// rather than blocking activation.
function isSystemDrivePrepared(deps: ReadinessDeps): boolean {
  const systemDrive = process.env.SystemDrive || "C:";
  let output: string;
  try {
    output = deps.execFileSync(resolveWindowsSystemExecutable("icacls.exe"), [`${systemDrive}\\`], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5_000,
      windowsHide: true,
    });
  } catch {
    // If icacls itself fails, assume prepared rather than emitting a spurious
    // warning on a host we cannot probe.
    return true;
  }
  // Look for the well-known ALL APPLICATION PACKAGES SID (S-1-15-2-1) or its
  // display name. Both forms can appear depending on OS locale/version.
  return output.includes("S-1-15-2-1") || output.includes("APPLICATION PACKAGES");
}

function systemDrivePrepWarning(systemDrive: string): string {
  return (
    `[mxc] MXC sandbox host preparation incomplete: the system drive root (${systemDrive}\\) ` +
    `does not grant directory access to AppContainer processes, so directory listing ` +
    `(e.g. \`dir\`) inside the sandbox will fail with "Access is denied". Basic read/write ` +
    `workloads still run.\n` +
    `Fix (one-time, elevated): wxc-host-prep prepare-system-drive (ships with @microsoft/mxc-sdk).`
  );
}

/**
 * Emits an advisory warning when the system drive is not prepared for
 * AppContainer directory access. Non-fatal: the sandbox still activates.
 */
export function warnMxcHostPrepIfNeeded(
  params: {
    platform?: NodeJS.Platform;
    deps?: Partial<ReadinessDeps>;
    warn?: (message: string) => void;
  } = {},
): void {
  const platform = params.platform ?? process.platform;
  if (platform !== "win32") {
    return;
  }
  const deps = { ...DEFAULT_DEPS, ...params.deps };
  if (!isSystemDrivePrepared(deps)) {
    const warn = params.warn ?? ((message: string) => console.warn(message));
    warn(systemDrivePrepWarning(process.env.SystemDrive || "C:"));
  }
}

export function assertMxcReadiness(
  params: {
    platform?: NodeJS.Platform;
    deps?: Partial<ReadinessDeps>;
  } = {},
): void {
  const platform = params.platform ?? process.platform;
  if (platform !== "win32") {
    return;
  }
  const deps = { ...DEFAULT_DEPS, ...params.deps };
  assertWindowsIsoEnvBrokerInstalled(deps);
}
