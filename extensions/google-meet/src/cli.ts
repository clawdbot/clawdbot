import type { Command } from "commander";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import {
  buildGoogleMeetCalendarDayWindow,
  findGoogleMeetCalendarEvent,
  type GoogleMeetCalendarLookupResult,
} from "./calendar.js";
import { registerGoogleMeetArtifactCommands } from "./cli-artifact-commands.js";
import type { GoogleMeetCliCommandContext } from "./cli-command-context.js";
import { registerGoogleMeetDoctorCommand } from "./cli-doctor.js";
import {
  registerGoogleMeetLifecycleCommands,
  registerGoogleMeetProbeCommands,
  registerGoogleMeetSessionCommands,
} from "./cli-runtime-commands.js";
import {
  parseOptionalNumber,
  parsePositiveIntegerOption,
  promptInput,
  resolveGoogleMeetOAuthCallbackTimeoutMs,
  testing,
  type CreateOptions,
  type MeetArtifactOptions,
  type OAuthLoginOptions,
  type ResolveSpaceOptions,
  writeStdoutJson,
  writeStdoutLine,
} from "./cli-shared.js";
import {
  registerGoogleMeetApiCommands,
  registerGoogleMeetCreateCommands,
} from "./cli-space-commands.js";
import { resolveGoogleMeetGatewayOperationTimeoutMs, type GoogleMeetConfig } from "./config.js";
import {
  buildGoogleMeetAuthUrl,
  createGoogleMeetOAuthState,
  createGoogleMeetPkce,
  exchangeGoogleMeetAuthCode,
  waitForGoogleMeetAuthCode,
} from "./oauth.js";
import type { GoogleMeetRuntime } from "./runtime.js";

export {
  buildGoogleMeetExportManifest,
  googleMeetExportFileNames,
  writeMeetExportBundle,
} from "./cli-export.js";
export { testing };

function resolveMeetingInput(config: GoogleMeetConfig, value?: string): string {
  const meeting = value?.trim() || config.defaults.meeting;
  if (!meeting) {
    throw new Error(
      "Meeting input is required. Pass a URL/meeting code or configure defaults.meeting.",
    );
  }
  return meeting;
}

function resolveOAuthTokenOptions(
  config: GoogleMeetConfig,
  options: ResolveSpaceOptions,
): {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
} {
  return {
    clientId: options.clientId?.trim() || config.oauth.clientId,
    clientSecret: options.clientSecret?.trim() || config.oauth.clientSecret,
    refreshToken: options.refreshToken?.trim() || config.oauth.refreshToken,
    accessToken: options.accessToken?.trim() || config.oauth.accessToken,
    expiresAt: parseOptionalNumber(options.expiresAt) ?? config.oauth.expiresAt,
  };
}

function resolveTokenOptions(
  config: GoogleMeetConfig,
  options: ResolveSpaceOptions,
): {
  meeting: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
} {
  return {
    meeting: resolveMeetingInput(config, options.meeting),
    ...resolveOAuthTokenOptions(config, options),
  };
}

function hasCalendarLookupOptions(options: ResolveSpaceOptions): boolean {
  return Boolean(options.today || options.event?.trim());
}

async function resolveCalendarMeetingInput(params: {
  accessToken: string;
  options: ResolveSpaceOptions;
}): Promise<{ meeting?: string; calendarEvent?: GoogleMeetCalendarLookupResult }> {
  if (!hasCalendarLookupOptions(params.options)) {
    return {};
  }
  const window = params.options.today ? buildGoogleMeetCalendarDayWindow() : {};
  const calendarEvent = await findGoogleMeetCalendarEvent({
    accessToken: params.accessToken,
    calendarId: params.options.calendar,
    eventQuery: params.options.event,
    ...window,
  });
  return { meeting: calendarEvent.meetingUri, calendarEvent };
}

async function resolveMeetingForToken(params: {
  config: GoogleMeetConfig;
  options: ResolveSpaceOptions;
  accessToken: string;
  configuredMeeting?: string;
}): Promise<{ meeting: string; calendarEvent?: GoogleMeetCalendarLookupResult }> {
  const calendarMeeting = await resolveCalendarMeetingInput({
    accessToken: params.accessToken,
    options: params.options,
  });
  const meeting =
    calendarMeeting.meeting ?? params.configuredMeeting ?? params.config.defaults.meeting;
  if (!meeting) {
    throw new Error(
      "Meeting input is required. Pass --meeting, --today, --event, or configure defaults.meeting.",
    );
  }
  return calendarMeeting.calendarEvent
    ? { meeting, calendarEvent: calendarMeeting.calendarEvent }
    : { meeting };
}

function resolveCreateTokenOptions(
  config: GoogleMeetConfig,
  options: CreateOptions,
): {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
} {
  return {
    clientId: options.clientId?.trim() || config.oauth.clientId,
    clientSecret: options.clientSecret?.trim() || config.oauth.clientSecret,
    refreshToken: options.refreshToken?.trim() || config.oauth.refreshToken,
    accessToken: options.accessToken?.trim() || config.oauth.accessToken,
    expiresAt: parseOptionalNumber(options.expiresAt) ?? config.oauth.expiresAt,
  };
}

function resolveArtifactTokenOptions(
  config: GoogleMeetConfig,
  options: MeetArtifactOptions,
): {
  meeting?: string;
  conferenceRecord?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  pageSize?: number;
  includeTranscriptEntries?: boolean;
  allConferenceRecords?: boolean;
  includeDocumentBodies?: boolean;
  mergeDuplicateParticipants?: boolean;
  lateAfterMinutes?: number;
  earlyBeforeMinutes?: number;
} {
  const meeting = options.meeting?.trim() || config.defaults.meeting;
  const conferenceRecord = options.conferenceRecord?.trim();
  if (!meeting && !conferenceRecord && !hasCalendarLookupOptions(options)) {
    throw new Error(
      "Meeting input or conference record is required. Pass --meeting, --today, --event, --conference-record, or configure defaults.meeting.",
    );
  }
  return {
    meeting,
    conferenceRecord,
    clientId: options.clientId?.trim() || config.oauth.clientId,
    clientSecret: options.clientSecret?.trim() || config.oauth.clientSecret,
    refreshToken: options.refreshToken?.trim() || config.oauth.refreshToken,
    accessToken: options.accessToken?.trim() || config.oauth.accessToken,
    expiresAt: parseOptionalNumber(options.expiresAt) ?? config.oauth.expiresAt,
    pageSize: parsePositiveIntegerOption(options.pageSize, "page-size"),
    includeTranscriptEntries: options.transcriptEntries !== false,
    allConferenceRecords: Boolean(options.allConferenceRecords),
    includeDocumentBodies: Boolean(options.includeDocBodies),
    mergeDuplicateParticipants: options.mergeDuplicates !== false,
    lateAfterMinutes: parseOptionalNumber(options.lateAfterMinutes),
    earlyBeforeMinutes: parseOptionalNumber(options.earlyBeforeMinutes),
  };
}

function hasCreateOAuth(config: GoogleMeetConfig, options: CreateOptions): boolean {
  return Boolean(
    options.accessToken?.trim() ||
    options.refreshToken?.trim() ||
    config.oauth.accessToken ||
    config.oauth.refreshToken,
  );
}

export function registerGoogleMeetCli(params: {
  program: Command;
  config: GoogleMeetConfig;
  ensureRuntime: () => Promise<GoogleMeetRuntime>;
  callGatewayFromCli?: typeof callGatewayFromCli;
}): void {
  const callGateway = params.callGatewayFromCli ?? callGatewayFromCli;
  const operationTimeoutMs = resolveGoogleMeetGatewayOperationTimeoutMs(params.config);
  const root = params.program
    .command("googlemeet")
    .description("Google Meet participant utilities")
    .addHelpText("after", () => `\nDocs: https://docs.openclaw.ai/plugins/google-meet\n`);

  const auth = root.command("auth").description("Google Meet OAuth helpers");

  auth
    .command("login")
    .description("Run a PKCE OAuth flow and print refresh-token JSON to store in plugin config")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--manual", "Use copy/paste callback flow instead of localhost callback")
    .option("--json", "Print the token payload as JSON", false)
    .option("--timeout-sec <n>", "Local callback timeout in seconds", "300")
    .action(async (options: OAuthLoginOptions) => {
      const clientId = options.clientId?.trim() || params.config.oauth.clientId;
      const clientSecret = options.clientSecret?.trim() || params.config.oauth.clientSecret;
      if (!clientId) {
        throw new Error(
          "Missing Google Meet OAuth client id. Configure oauth.clientId or pass --client-id.",
        );
      }
      const { verifier, challenge } = createGoogleMeetPkce();
      const state = createGoogleMeetOAuthState();
      const authUrl = buildGoogleMeetAuthUrl({
        clientId,
        challenge,
        state,
      });
      const code = await waitForGoogleMeetAuthCode({
        state,
        manual: Boolean(options.manual),
        timeoutMs: resolveGoogleMeetOAuthCallbackTimeoutMs(options.timeoutSec),
        authUrl,
        promptInput,
        writeLine: (message) => writeStdoutLine("%s", message),
      });
      const tokens = await exchangeGoogleMeetAuthCode({
        clientId,
        clientSecret,
        code,
        verifier,
      });
      if (!tokens.refreshToken) {
        throw new Error(
          "Google OAuth did not return a refresh token. Re-run the flow with consent and offline access.",
        );
      }
      const payload = {
        oauth: {
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
        },
        scope: tokens.scope,
        tokenType: tokens.tokenType,
      };
      if (!options.json) {
        writeStdoutLine("Paste this into plugins.entries.google-meet.config:");
      }
      writeStdoutJson(payload);
    });
  const context: GoogleMeetCliCommandContext = {
    root,
    config: params.config,
    ensureRuntime: params.ensureRuntime,
    callGateway,
    operationTimeoutMs,
    resolveMeetingInput,
    resolveOAuthTokenOptions,
    resolveTokenOptions,
    resolveMeetingForToken,
    resolveCreateTokenOptions,
    resolveArtifactTokenOptions,
    hasCreateOAuth,
  };

  registerGoogleMeetCreateCommands(context);
  registerGoogleMeetProbeCommands(context);
  registerGoogleMeetApiCommands(context);
  registerGoogleMeetArtifactCommands(context);
  registerGoogleMeetSessionCommands(context);
  registerGoogleMeetDoctorCommand(context);
  registerGoogleMeetLifecycleCommands(context);
}
