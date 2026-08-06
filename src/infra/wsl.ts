// Detects Windows Subsystem for Linux environments.
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

let wslCached: boolean | null = null;

/** Clears the cached async WSL detection result between isolated tests. */
export function resetWSLStateForTests(): void {
  wslCached = null;
}

/** Detects WSL from environment variables without touching the filesystem. */
export function isWSLEnv(env: Record<string, string | undefined> = process.env): boolean {
  if (env.WSL_INTEROP || env.WSL_DISTRO_NAME || env.WSLENV) {
    return true;
  }
  return false;
}

/**
 * Synchronously detects WSL from env vars first, then `/proc/version`.
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
 * Synchronously detects WSL2 from kernel-version markers after WSL detection.
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

/** Asynchronously detects WSL from env vars and `/proc/sys/kernel/osrelease`, with process cache. */
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
