import type { Command } from "commander";
import type { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import type { GoogleMeetCalendarLookupResult } from "./calendar.js";
import type { CreateOptions, MeetArtifactOptions, ResolveSpaceOptions } from "./cli-shared.js";
import type { GoogleMeetConfig } from "./config.js";
import type { GoogleMeetRuntime } from "./runtime.js";

type GoogleMeetOAuthTokenOptions = {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
};

type GoogleMeetArtifactTokenOptions = GoogleMeetOAuthTokenOptions & {
  meeting?: string;
  conferenceRecord?: string;
  pageSize?: number;
  includeTranscriptEntries?: boolean;
  allConferenceRecords?: boolean;
  includeDocumentBodies?: boolean;
  mergeDuplicateParticipants?: boolean;
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
  resolveOAuthTokenOptions: (
    config: GoogleMeetConfig,
    options: ResolveSpaceOptions,
  ) => GoogleMeetOAuthTokenOptions;
  resolveTokenOptions: (
    config: GoogleMeetConfig,
    options: ResolveSpaceOptions,
  ) => GoogleMeetOAuthTokenOptions & { meeting: string };
  resolveMeetingForToken: (params: {
    config: GoogleMeetConfig;
    options: ResolveSpaceOptions;
    accessToken: string;
    configuredMeeting?: string;
  }) => Promise<{ meeting: string; calendarEvent?: GoogleMeetCalendarLookupResult }>;
  resolveCreateTokenOptions: (
    config: GoogleMeetConfig,
    options: CreateOptions,
  ) => GoogleMeetOAuthTokenOptions;
  resolveArtifactTokenOptions: (
    config: GoogleMeetConfig,
    options: MeetArtifactOptions,
  ) => GoogleMeetArtifactTokenOptions;
  hasCreateOAuth: (config: GoogleMeetConfig, options: CreateOptions) => boolean;
};
