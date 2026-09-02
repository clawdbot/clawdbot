import fs from "node:fs/promises";
import path from "node:path";
import { isPidAlive } from "../shared/pid-alive.js";

export async function writeForkingNoOutputScript(dir: string): Promise<string> {
  const scriptPath = path.join(dir, "fork-no-output.sh");
  // The readiness byte on stderr re-arms the caller's rolling no-output timer,
  // so the silence window that kills the tree starts only after the forked pid
  // is on disk; without it, slow spawns under suite load race the first window
  // and the test reads a missing/empty pid file.
  await fs.writeFile(
    scriptPath,
    [
      "#!/bin/sh",
      '"$NODE_BINARY" -e "setInterval(() => {}, 1000)" &',
      'printf "%s" "$!" > "$PID_FILE"',
      "echo ready >&2",
      "sleep 30",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(scriptPath, 0o700);
  return scriptPath;
}

export async function waitForPidToExit(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return !isPidAlive(pid);
}

export async function readPidFile(pidPath: string): Promise<number> {
  return Number((await fs.readFile(pidPath, "utf8")).trim());
}

export async function waitForPidFile(pidPath: string, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = await readPidFile(pidPath);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`Timed out waiting for pid file: ${pidPath}`);
}

export function killPidIfAlive(pid: number | undefined): void {
  if (pid === undefined || !isPidAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    // The process can exit after the liveness probe; ESRCH already satisfies cleanup.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH") {
      throw error;
    }
  }
}
