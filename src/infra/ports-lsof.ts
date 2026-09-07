// Uses lsof output to map listening ports to local processes.
import fs from "node:fs";
import fsPromises from "node:fs/promises";

const LSOF_CANDIDATES =
  process.platform === "darwin"
    ? ["/usr/sbin/lsof", "/usr/bin/lsof"]
    : ["/usr/bin/lsof", "/usr/sbin/lsof"];

async function canExecute(path: string): Promise<boolean> {
  try {
    await fsPromises.access(path, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveLsofCommand(): Promise<string> {
  for (const candidate of LSOF_CANDIDATES) {
    if (await canExecute(candidate)) {
      return candidate;
    }
  }
  return "lsof";
}

export function resolveLsofCommandSync(): string {
  for (const candidate of LSOF_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep trying
    }
  }
  return "lsof";
}
