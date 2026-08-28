// Resolves the platform OpenSSH client without consulting PATH.
import path from "node:path";
import { resolveSystemBin } from "./resolve-system-bin.js";
import { getWindowsInstallRoots } from "./windows-install-roots.js";

export function resolveSshClient(): string | null {
  if (process.platform !== "win32") {
    return resolveSystemBin("ssh", { trust: "strict" });
  }

  // Windows installs its optional OpenSSH client below System32. Keep this
  // directory SSH-specific instead of widening strict lookup for every tool.
  const { systemRoot } = getWindowsInstallRoots();
  const openSshDir = path.win32.join(systemRoot, "System32", "OpenSSH");
  return resolveSystemBin("ssh", { trust: "strict", extraDirs: [openSshDir] });
}
