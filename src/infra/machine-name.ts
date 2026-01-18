import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let cachedPromise: Promise<string> | null = null;

async function tryScutil(key: "ComputerName" | "LocalHostName") {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--get", key], {
      timeout: 1000,
      windowsHide: true,
    });
    const value = String(stdout ?? "").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function fallbackHostName() {
  return (
    os
      .hostname()
      .replace(/\.local$/i, "")
      .trim() || "clawdbot"
  );
}

export async function getMachineDisplayName(): Promise<string> {
  if (cachedPromise) return cachedPromise;
  cachedPromise = (async () => {
    if (process.env.VITEST || process.env.NODE_ENV === "test") {
      return fallbackHostName();
    }
    if (process.platform === "darwin") {
      const computerName = await tryScutil("ComputerName");
      if (computerName) return computerName;
      const localHostName = await tryScutil("LocalHostName");
      if (localHostName) return localHostName;
    }
    return fallbackHostName();
  })();
  return cachedPromise;
}
