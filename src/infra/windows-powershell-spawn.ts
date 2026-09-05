import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

// Windows PowerShell one-shots pay cold first-use costs: module analysis ("Preparing modules
// for first use") and NGEN image compilation exceeded 10 seconds on loaded CI runners.
// Fail-closed security gates must out-wait cold starts; this bound only stops true hangs.
export const WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS = 60_000;

export function sanitizePowerShellOutputText(text: string): string {
  return truncateUtf16Safe(
    text
      .split(/\r?\n/u)
      .filter((line) => !line.toLowerCase().includes("encodedcommand"))
      .join("\n")
      .trim(),
    1000,
  );
}

export function buildPowerShellFailureCause(error: unknown): Error {
  const failure = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const status = [
    typeof failure.status === "number" ? `status=${failure.status}` : "",
    typeof failure.code === "number"
      ? `exit=${failure.code}`
      : typeof failure.code === "string"
        ? `code=${failure.code}`
        : "",
    typeof failure.killed === "boolean" ? `killed=${failure.killed}` : "",
    typeof failure.signal === "string" ? `signal=${failure.signal}` : "",
  ].filter(Boolean);
  const stderr =
    typeof failure.stderr === "string" ? sanitizePowerShellOutputText(failure.stderr) : "";
  const stdout =
    typeof failure.stdout === "string" ? sanitizePowerShellOutputText(failure.stdout) : "";
  const detail = stderr ? `stderr: ${stderr}` : stdout ? `stdout: ${stdout}` : "";
  return new Error(
    `PowerShell failed${status.length ? ` (${status.join(", ")})` : ""}${detail ? `; ${detail}` : ""}`,
  );
}

export function buildEncodedPowerShellArgs(command: string): string[] {
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  // Canonical argv for non-interactive encoded one-shots.
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand];
}
