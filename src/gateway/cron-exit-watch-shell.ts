/** Resolve the native shell used for watched commands on each gateway platform. */
export function resolveExitWatchShell(platform: NodeJS.Platform = process.platform): {
  command: string;
  argsFor: (command: string) => string[];
} {
  if (platform === "win32") {
    return {
      command: process.env.ComSpec?.trim() || "cmd.exe",
      // /d skip AutoRun, /s strip outer quotes, /c run then exit.
      argsFor: (command: string) => ["/d", "/s", "/c", command],
    };
  }
  return { command: "bash", argsFor: (command: string) => ["-lc", command] };
}
