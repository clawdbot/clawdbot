import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

let wslCached: boolean | null = null;

export function resetWSLStateForTests(): void {
  wslCached = null;
}

export function isWSLEnv(): boolean {
  if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME || process.env.WSLENV) {
    return true;
  }
  return false;
}

/**
 * Synchronously check if running in WSL.
 * Checks env vars first, then /proc/version.
 */
export function isWSLSync(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  if (isWSLEnv()) {
    return true;
  }
  try {
    const release = normalizeLowercaseStringOrEmpty(readFileSync("/proc/version", "utf8"));
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

/**
 * Synchronously check if running in WSL2.
 */
export function isWSL2Sync(): boolean {
  if (!isWSLSync()) {
    return false;
  }
  try {
    const version = normalizeLowercaseStringOrEmpty(readFileSync("/proc/version", "utf8"));
    return version.includes("wsl2") || version.includes("microsoft-standard");
  } catch {
    return false;
  }
}

export async function isWSL(): Promise<boolean> {
  if (wslCached !== null) {
    return wslCached;
  }
  if (process.platform !== "linux") {
    wslCached = false;
    return wslCached;
  }
  if (isWSLEnv()) {
    wslCached = true;
    return wslCached;
  }
  try {
    const release = normalizeLowercaseStringOrEmpty(
      await fs.readFile("/proc/sys/kernel/osrelease", "utf8"),
    );
    wslCached = release.includes("microsoft") || release.includes("wsl");
  } catch {
    wslCached = false;
  }
  return wslCached;
}
