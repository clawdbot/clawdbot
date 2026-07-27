import { getRootOptionAwareCommandPath } from "openclaw/plugin-sdk/cli-argv";

/** Every Teams meetings action emits one JSON result on stdout. */
function isTeamsMeetingsMachineOutput(params: { argv: readonly string[] }): boolean {
  return getRootOptionAwareCommandPath(params.argv, 2).length === 2;
}

export const TEAMS_MEETINGS_CLI_DESCRIPTOR = {
  name: "teamsmeetings",
  description: "Join and manage Microsoft Teams meeting guests",
  hasSubcommands: true,
  machineOutput: isTeamsMeetingsMachineOutput,
} as const;
