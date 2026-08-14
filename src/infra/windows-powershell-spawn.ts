// Windows PowerShell one-shots pay cold first-use costs: module analysis ("Preparing modules
// for first use") and NGEN image compilation exceeded 10 seconds on loaded CI runners.
// Fail-closed security gates must out-wait cold starts; this bound only stops true hangs.
export const WINDOWS_POWERSHELL_COLD_SPAWN_TIMEOUT_MS = 60_000;

export function buildEncodedPowerShellArgs(command: string): string[] {
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  // Canonical argv for non-interactive encoded one-shots.
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand];
}
