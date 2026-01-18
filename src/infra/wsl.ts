import fs from "node:fs/promises";

let wslCached: boolean | null = null;

export function isWSLEnv(): boolean {
  if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME || process.env.WSLENV) {
    return true;
  }
  return false;
}

export async function isWSL(): Promise<boolean> {
  if (wslCached !== null) return wslCached;
  if (isWSLEnv()) {
    wslCached = true;
    return wslCached;
  }
  try {
    const release = await fs.readFile("/proc/sys/kernel/osrelease", "utf8");
    wslCached =
      release.toLowerCase().includes("microsoft") || release.toLowerCase().includes("wsl");
  } catch {
    wslCached = false;
  }
  return wslCached;
}
