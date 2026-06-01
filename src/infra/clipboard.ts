import { runCommandWithTimeout } from "../process/exec.js";
import { isWSL2Sync } from "./wsl.js";

// WSL interop needs a shell to launch Windows PE binaries; exec keeps the
// clipboard process as the timeout-owned child while values stay on stdin.
const WSL_CLIPBOARD_ARGV = ["/bin/sh", "-c", "exec /mnt/c/Windows/System32/clip.exe"];

export async function copyToClipboard(value: string): Promise<boolean> {
  const attempts: Array<{ argv: string[] }> = [
    ...(isWSL2Sync() ? [{ argv: WSL_CLIPBOARD_ARGV }] : []),
    { argv: ["pbcopy"] },
    { argv: ["xclip", "-selection", "clipboard"] },
    { argv: ["wl-copy"] },
    { argv: ["clip.exe"] },
    { argv: ["powershell", "-NoProfile", "-Command", "Set-Clipboard"] },
  ];
  for (const attempt of attempts) {
    try {
      const result = await runCommandWithTimeout(attempt.argv, {
        timeoutMs: 3_000,
        input: value,
      });
      if (result.code === 0 && !result.killed) {
        return true;
      }
    } catch {
      // keep trying the next fallback
    }
  }
  return false;
}
