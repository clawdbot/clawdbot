import { getRootOptionAwareCommandPath } from "openclaw/plugin-sdk/cli-argv";

const DEFAULT_JSON_COMMANDS = new Set(["join", "status", "test-listen", "test-speech"]);

function hasOption(argv: readonly string[], flag: string): boolean {
  for (const arg of argv.slice(2)) {
    if (arg === "--") {
      return false;
    }
    if (arg === flag || arg.startsWith(`${flag}=`)) {
      return true;
    }
  }
  return false;
}

/** Runtime probe commands emit JSON without requiring the shared `--json` option. */
function isGoogleMeetMachineOutput(params: { argv: readonly string[] }): boolean {
  const [, command] = getRootOptionAwareCommandPath(params.argv, 2);
  return (
    DEFAULT_JSON_COMMANDS.has(command ?? "") ||
    (command === "export" && hasOption(params.argv, "--dry-run"))
  );
}

export const GOOGLE_MEET_CLI_DESCRIPTOR = {
  name: "googlemeet",
  description: "Join and manage Google Meet calls",
  hasSubcommands: true,
  machineOutput: isGoogleMeetMachineOutput,
} as const;
