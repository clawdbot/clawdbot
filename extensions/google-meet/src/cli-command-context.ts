import type { Command } from "commander";
import type { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import type { CreateOptions, MeetArtifactOptions, ResolveSpaceOptions } from "./cli-shared.js";
import type { GoogleMeetConfig } from "./config.js";
import type { GoogleMeetRuntime } from "./runtime.js";

export function addGoogleMeetOAuthOptions(command: Command): Command {
  return command
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds");
}

export function addGoogleMeetMeetingOption(command: Command): Command {
  return command.option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}");
}

export function addGoogleMeetCalendarOptions(command: Command): Command {
  return command
    .option("--today", "Find a Meet link on today's calendar")
    .option("--event <query>", "Find a matching calendar event with a Meet link")
    .option("--calendar <id>", "Calendar id for --today or --event", "primary");
}

export function addGoogleMeetArtifactOptions(command: Command): Command {
  const withMeeting = addGoogleMeetMeetingOption(command).option(
    "--conference-record <name>",
    "Conference record name or id",
  );
  return addGoogleMeetOAuthOptions(addGoogleMeetCalendarOptions(withMeeting))
    .option("--page-size <n>", "Max resources per Meet API page")
    .option("--all-conference-records", "Fetch every conference record for --meeting");
}

type GoogleMeetCliArtifactParams = Record<string, unknown> & {
  lateAfterMinutes?: number;
  earlyBeforeMinutes?: number;
};

export type GoogleMeetCliCommandContext = {
  root: Command;
  config: GoogleMeetConfig;
  ensureRuntime: () => Promise<GoogleMeetRuntime>;
  callGateway: typeof callGatewayFromCli;
  operationTimeoutMs: number;
  resolveMeetingInput: (config: GoogleMeetConfig, value?: string) => string;
  resolveCliParams: (options: ResolveSpaceOptions) => Record<string, unknown>;
  resolveCliArtifactParams: (options: MeetArtifactOptions) => GoogleMeetCliArtifactParams;
  hasCreateOAuth: (config: GoogleMeetConfig, options: CreateOptions) => boolean;
};
