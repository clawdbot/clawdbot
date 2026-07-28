import { getRootOptionAwareCommandPath } from "openclaw/plugin-sdk/cli-argv";

/** Every Zoom meetings action emits one JSON result on stdout. */
function isZoomMeetingsMachineOutput(params: { argv: readonly string[] }): boolean {
  return getRootOptionAwareCommandPath(params.argv, 2).length === 2;
}

export const ZOOM_MEETINGS_CLI_DESCRIPTOR = {
  name: "zoommeetings",
  description: "Join and manage Zoom meeting guests",
  hasSubcommands: true,
  machineOutput: isZoomMeetingsMachineOutput,
} as const;
