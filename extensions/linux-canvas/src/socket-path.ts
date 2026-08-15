import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const log = createSubsystemLogger("linux-canvas");

function reportSocketWatchError(directory: string, error: unknown): void {
  log.warn(
    `linux canvas socket watcher unavailable for ${directory}; continuing with availability polling: ${String(error)}`,
  );
}

export function resolveLinuxCanvasSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
): string {
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir) {
    return path.join(runtimeDir, "openclaw-canvas.sock");
  }
  return path.join("/tmp", `openclaw-canvas-${uid ?? "unknown"}.sock`);
}

export function linuxCanvasSocketExists(socketPath: string): boolean {
  try {
    const stat = fs.lstatSync(socketPath);
    const uid = process.geteuid?.() ?? process.getuid?.();
    if (!stat.isSocket() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
      return false;
    }
    const procSockets = fs.readFileSync("/proc/net/unix", "utf8");
    return procSockets.split("\n").some((line) => line.endsWith(` ${socketPath}`));
  } catch {
    return false;
  }
}

export function watchLinuxCanvasSocket(socketPath: string, onChange: () => void): () => void {
  const directory = path.dirname(socketPath);
  const socketName = path.basename(socketPath);
  try {
    const watcher = fs.watch(directory, (_event, filename) => {
      if (!filename || filename === socketName) {
        onChange();
      }
    });
    watcher.on("error", (error) => reportSocketWatchError(directory, error));
    return () => watcher.close();
  } catch (error) {
    reportSocketWatchError(directory, error);
    return () => {};
  }
}
