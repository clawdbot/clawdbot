import { getRootOptionAwareCommandPath } from "openclaw/plugin-sdk/cli-argv";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

// Metadata discovery for unrelated commands must not load the meeting runtime.
const descriptor = {
  name: "teamsmeetings",
  description: "Join and manage Microsoft Teams meeting guests",
  hasSubcommands: true,
  machineOutput: ({ argv }: { argv: readonly string[] }) =>
    getRootOptionAwareCommandPath(argv, 2).length === 2,
} as const;

export const TEAMS_MEETINGS_CLI_METADATA = {
  id: "teams-meetings",
  name: "Microsoft Teams meetings",
  description: "Microsoft Teams meetings CLI metadata",
  descriptor,
  register(api: OpenClawPluginApi) {
    api.registerCli(() => {}, { descriptors: [descriptor] });
  },
};
