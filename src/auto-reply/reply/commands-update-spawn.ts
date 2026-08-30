// Detaches `openclaw update` so the chat /update command survives gateway restart.
import { spawn } from "node:child_process";

export type DetachedChatUpdateResult =
  | { ok: true; pid?: number }
  | { ok: false; detail?: string };

export function spawnDetachedChatUpdate(
  spawnImpl: typeof spawn = spawn,
): DetachedChatUpdateResult {
  try {
    const child = spawnImpl(process.execPath, [process.argv[1] ?? "openclaw", "update", "--yes"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    return { ok: true, ...(typeof child.pid === "number" ? { pid: child.pid } : {}) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
