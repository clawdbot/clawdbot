// Resolves a human-readable machine name for gateway display.
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const execFileAsync = promisify(execFile);

// Machine display names prefer macOS ComputerName when available and fall back
// to hostname for deterministic tests and non-macOS hosts.
let cachedPromise: Promise<string> | null = null;

async function tryScutil(key: "ComputerName" | "LocalHostName") {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--get", key], {
      timeout: 1000,
      windowsHide: true,
    });
    const value = normalizeOptionalString(stdout ?? "") ?? "";
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function fallbackHostName() {
  const trimmed = normalizeOptionalString(os.hostname()) ?? "";
  return trimmed.replace(/\.local$/i, "") || "openclaw";
}

/** Resolve a user-facing name for the current machine. */
export async function getMachineDisplayName(): Promise<string> {
  if (cachedPromise) {
    return cachedPromise;
  }
  cachedPromise = (async () => {
    if (process.env.VITEST || process.env.NODE_ENV === "test") {
      return fallbackHostName();
    }
    if (process.platform === "darwin") {
      const computerName = await tryScutil("ComputerName");
      if (computerName) {
        return computerName;
      }
      const localHostName = await tryScutil("LocalHostName");
      if (localHostName) {
        return localHostName;
      }
    }
    return fallbackHostName();
  })();
  return cachedPromise;
}
