// Reads and writes clipboard text through platform command helpers.
import { Buffer } from "node:buffer";
import { runCommandWithTimeout } from "../process/exec.js";
import { isWSL2Sync } from "./wsl.js";

// WSL interop needs a shell to launch Windows PE binaries; exec keeps the
// clipboard process as the timeout-owned child while values stay on stdin.
const WSL_CLIPBOARD_ARGV = ["/bin/sh", "-c", "exec /mnt/c/Windows/System32/clip.exe"];
const POWERSHELL_CLIPBOARD_ARGV = [
  "powershell",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "$encoded = [Console]::In.ReadToEnd(); $bytes = [Convert]::FromBase64String($encoded); Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString($bytes))",
];

export async function copyToClipboard(value: string): Promise<boolean> {
  const attempts: Array<{ argv: string[]; input: string }> = [
    ...(isWSL2Sync() ? [{ argv: WSL_CLIPBOARD_ARGV, input: value }] : []),
    { argv: ["pbcopy"], input: value },
    { argv: ["xclip", "-selection", "clipboard"], input: value },
    { argv: ["wl-copy"], input: value },
    { argv: ["clip.exe"], input: value },
    {
      argv: POWERSHELL_CLIPBOARD_ARGV,
      input: Buffer.from(value, "utf8").toString("base64"),
    },
  ];
  for (const attempt of attempts) {
    try {
      const result = await runCommandWithTimeout(attempt.argv, {
        timeoutMs: 3_000,
        input: attempt.input,
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
