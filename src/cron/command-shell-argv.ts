// Builds the platform shell wrapper persisted for cron command payloads. Jobs
// execute through the platform default shell on the gateway host, mirroring
// buildNodeShellCommand for Node-driven command execution.
export function buildCronCommandShellArgv(
  command: string,
  platform: string = process.platform,
): string[] {
  if (platform === "win32") {
    return ["cmd.exe", "/d", "/s", "/c", command];
  }
  return ["sh", "-lc", command];
}
