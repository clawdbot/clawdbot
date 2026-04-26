import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { Type } from "typebox";
import {
  buildGoogleMeetCalendarDayWindow,
  findGoogleMeetCalendarEvent,
  listGoogleMeetCalendarEvents,
  type GoogleMeetCalendarLookupResult,
} from "./src/calendar.js";
import {
  resolveGoogleMeetConfig,
  type GoogleMeetConfig,
  type GoogleMeetMode,
  type GoogleMeetTransport,
} from "./src/config.js";
import {
  buildGoogleMeetPreflightReport,
  fetchGoogleMeetArtifacts,
  fetchGoogleMeetAttendance,
  fetchLatestGoogleMeetConferenceRecord,
  fetchGoogleMeetSpace,
} from "./src/meet.js";
import { handleGoogleMeetNodeHostCommand } from "./src/node-host.js";
import { GoogleMeetRuntime } from "./src/runtime.js";
import { isGoogleMeetBrowserManualActionError } from "./src/transports/chrome-create.js";

const googleMeetConfigSchema = {
  parse(value: unknown) {
    return resolveGoogleMeetConfig(value);
  },
  uiHints: {
    "defaults.meeting": {
      label: "Default Meeting",
      help: "Meet URL, meeting code, or spaces/{id} used when CLI commands omit a meeting.",
    },
    "preview.enrollmentAcknowledged": {
      label: "Preview Acknowledged",
      help: "Confirms you understand the Google Meet Media API is still Developer Preview.",
      advanced: true,
    },
    defaultTransport: {
      label: "Default Transport",
      help: "Chrome uses a signed-in browser profile. Chrome-node runs Chrome on a paired node. Twilio uses Meet dial-in numbers.",
    },
    defaultMode: {
      label: "Default Mode",
      help: "Realtime starts the duplex voice model loop. Transcribe joins/observes without the realtime talk-back bridge.",
    },
    "chrome.audioBackend": {
      label: "Chrome Audio Backend",
      help: "BlackHole 2ch is required for local duplex audio routing.",
    },
    "chrome.launch": { label: "Launch Chrome" },
    "chrome.browserProfile": { label: "Chrome Profile", advanced: true },
    "chrome.guestName": {
      label: "Guest Name",
      help: "Used when Chrome lands on the signed-out Meet guest-name screen.",
    },
    "chrome.reuseExistingTab": {
      label: "Reuse Existing Meet Tab",
      help: "Avoids opening duplicate tabs for the same Meet URL.",
    },
    "chrome.autoJoin": {
      label: "Auto Join Guest Screen",
      help: "Best-effort guest-name fill and Join Now click through OpenClaw browser automation.",
    },
    "chrome.waitForInCallMs": {
      label: "Wait For In-Call (ms)",
      help: "Waits for Chrome to report that the Meet tab is in-call before the realtime intro speaks.",
      advanced: true,
    },
    "chrome.audioInputCommand": {
      label: "Audio Input Command",
      help: "Command that writes 8 kHz G.711 mu-law meeting audio to stdout.",
      advanced: true,
    },
    "chrome.audioOutputCommand": {
      label: "Audio Output Command",
      help: "Command that reads 8 kHz G.711 mu-law assistant audio from stdin.",
      advanced: true,
    },
    "chrome.audioBridgeCommand": { label: "Audio Bridge Command", advanced: true },
    "chrome.audioBridgeHealthCommand": {
      label: "Audio Bridge Health Command",
      advanced: true,
    },
    "chromeNode.node": {
      label: "Chrome Node",
      help: "Node id/name/IP that owns Chrome, BlackHole, and SoX for chrome-node transport.",
      advanced: true,
    },
    "twilio.defaultDialInNumber": {
      label: "Default Dial-In Number",
      placeholder: "+15551234567",
    },
    "twilio.defaultPin": { label: "Default PIN", advanced: true },
    "twilio.defaultDtmfSequence": { label: "Default DTMF Sequence", advanced: true },
    "voiceCall.enabled": { label: "Delegate To Voice Call" },
    "voiceCall.gatewayUrl": { label: "Voice Call Gateway URL", advanced: true },
    "voiceCall.token": {
      label: "Voice Call Gateway Token",
      sensitive: true,
      advanced: true,
    },
    "voiceCall.requestTimeoutMs": {
      label: "Voice Call Request Timeout (ms)",
      advanced: true,
    },
    "voiceCall.dtmfDelayMs": { label: "DTMF Delay (ms)", advanced: true },
    "voiceCall.introMessage": { label: "Voice Call Intro Message", advanced: true },
    "realtime.provider": {
      label: "Realtime Provider",
      help: "Defaults to OpenAI; uses OPENAI_API_KEY when no provider config is set.",
    },
    "realtime.model": { label: "Realtime Model", advanced: true },
    "realtime.instructions": { label: "Realtime Instructions", advanced: true },
    "realtime.introMessage": {
      label: "Realtime Intro Message",
      help: "Spoken once when the realtime bridge is ready. Set to an empty string to join silently.",
    },
    "realtime.toolPolicy": {
      label: "Realtime Tool Policy",
      help: "Safe read-only tools are available by default; owner requests can unlock broader tools.",
      advanced: true,
    },
    "oauth.clientId": { label: "OAuth Client ID" },
    "oauth.clientSecret": { label: "OAuth Client Secret", sensitive: true },
    "oauth.refreshToken": { label: "OAuth Refresh Token", sensitive: true },
    "oauth.accessToken": {
      label: "Cached Access Token",
      sensitive: true,
      advanced: true,
    },
    "oauth.expiresAt": {
      label: "Cached Access Token Expiry",
      help: "Unix epoch milliseconds used only for the cached access-token fast path.",
      advanced: true,
    },
  },
};

const GoogleMeetToolSchema = Type.Object({
  action: Type.String({
    enum: [
      "join",
      "create",
      "status",
      "setup_status",
      "resolve_space",
      "preflight",
      "latest",
      "calendar_events",
      "artifacts",
      "attendance",
      "export",
      "recover_current_tab",
      "leave",
      "speak",
      "test_speech",
    ],
    description:
      "Google Meet action to run. create creates and joins by default; pass join=false to only mint a URL. After a timeout or unclear browser state, call recover_current_tab before retrying join.",
  }),
  join: Type.Optional(
    Type.Boolean({
      description: "For action=create, set false to create the URL without joining.",
    }),
  ),
  url: Type.Optional(Type.String({ description: "Explicit https://meet.google.com/... URL" })),
  transport: Type.Optional(
    Type.String({ enum: ["chrome", "chrome-node", "twilio"], description: "Join transport" }),
  ),
  mode: Type.Optional(
    Type.String({
      enum: ["realtime", "transcribe"],
      description:
        "Join mode. realtime starts live listen/talk-back through the realtime voice model; transcribe joins without the realtime talk-back bridge.",
    }),
  ),
  dialInNumber: Type.Optional(Type.String({ description: "Meet dial-in number for Twilio" })),
  pin: Type.Optional(Type.String({ description: "Meet phone PIN for Twilio" })),
  dtmfSequence: Type.Optional(Type.String({ description: "Explicit DTMF sequence for Twilio" })),
  sessionId: Type.Optional(Type.String({ description: "Meet session ID" })),
  message: Type.Optional(Type.String({ description: "Realtime instructions to speak now" })),
  meeting: Type.Optional(Type.String({ description: "Meet URL, meeting code, or spaces/{id}" })),
  today: Type.Optional(
    Type.Boolean({
      description: "For latest, artifacts, or attendance, find a Meet link on today's calendar.",
    }),
  ),
  event: Type.Optional(
    Type.String({
      description: "For latest, artifacts, or attendance, find a matching Calendar event.",
    }),
  ),
  calendarId: Type.Optional(Type.String({ description: "Calendar id for today/event lookup" })),
  conferenceRecord: Type.Optional(
    Type.String({ description: "Meet conferenceRecords/{id} resource name or id" }),
  ),
  pageSize: Type.Optional(Type.Number({ description: "Meet API page size for list actions" })),
  includeTranscriptEntries: Type.Optional(
    Type.Boolean({ description: "For artifacts, include structured transcript entries" }),
  ),
  includeDocumentBodies: Type.Optional(
    Type.Boolean({
      description:
        "For artifacts/export, export linked transcript and smart-note Google Docs text through Drive.",
    }),
  ),
  outputDir: Type.Optional(Type.String({ description: "For export, output directory" })),
  zip: Type.Optional(Type.Boolean({ description: "For export, also write a .zip archive" })),
  dryRun: Type.Optional(
    Type.Boolean({
      description: "For export, return the manifest without writing files.",
    }),
  ),
  includeAllConferenceRecords: Type.Optional(
    Type.Boolean({
      description:
        "For artifacts, attendance, or export with meeting input, fetch all conference records instead of only the latest.",
    }),
  ),
  mergeDuplicateParticipants: Type.Optional(
    Type.Boolean({ description: "For attendance, merge duplicate participant resources." }),
  ),
  lateAfterMinutes: Type.Optional(
    Type.Number({ description: "For attendance, mark participants late after this many minutes." }),
  ),
  earlyBeforeMinutes: Type.Optional(
    Type.Number({ description: "For attendance, mark early leavers before this many minutes." }),
  ),
  accessToken: Type.Optional(Type.String({ description: "Access token override" })),
  refreshToken: Type.Optional(Type.String({ description: "Refresh token override" })),
  clientId: Type.Optional(Type.String({ description: "OAuth client id override" })),
  clientSecret: Type.Optional(Type.String({ description: "OAuth client secret override" })),
  expiresAt: Type.Optional(Type.Number({ description: "Cached access token expiry ms" })),
});

function asParamRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function json(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function normalizeTransport(value: unknown): GoogleMeetTransport | undefined {
  return value === "chrome" || value === "chrome-node" || value === "twilio" ? value : undefined;
}

function normalizeMode(value: unknown): GoogleMeetMode | undefined {
  return value === "realtime" || value === "transcribe" ? value : undefined;
}

function resolveMeetingInput(config: GoogleMeetConfig, value: unknown): string {
  const meeting = normalizeOptionalString(value) ?? config.defaults.meeting;
  if (!meeting) {
    throw new Error("Meeting input is required");
  }
  return meeting;
}

function resolveOptionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(normalizeOptionalString(value));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Expected pageSize to be a positive integer");
  }
  return parsed;
}

function shouldJoinCreatedMeet(raw: Record<string, unknown>): boolean {
  return raw.join !== false && raw.join !== "false";
}

async function createMeetFromParams(params: {
  config: GoogleMeetConfig;
  runtime: OpenClawPluginApi["runtime"];
  raw: Record<string, unknown>;
}) {
  const create = await import("./src/create.js");
  return create.createMeetFromParams(params);
}

async function createAndJoinMeetFromParams(params: {
  config: GoogleMeetConfig;
  runtime: OpenClawPluginApi["runtime"];
  raw: Record<string, unknown>;
  ensureRuntime: () => Promise<GoogleMeetRuntime>;
}) {
  const create = await import("./src/create.js");
  return create.createAndJoinMeetFromParams(params);
}

async function resolveGoogleMeetTokenFromParams(
  config: GoogleMeetConfig,
  raw: Record<string, unknown>,
) {
  const { resolveGoogleMeetAccessToken } = await import("./src/oauth.js");
  return resolveGoogleMeetAccessToken({
    clientId: normalizeOptionalString(raw.clientId) ?? config.oauth.clientId,
    clientSecret: normalizeOptionalString(raw.clientSecret) ?? config.oauth.clientSecret,
    refreshToken: normalizeOptionalString(raw.refreshToken) ?? config.oauth.refreshToken,
    accessToken: normalizeOptionalString(raw.accessToken) ?? config.oauth.accessToken,
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : config.oauth.expiresAt,
  });
}

function wantsCalendarLookup(raw: Record<string, unknown>): boolean {
  return raw.today === true || Boolean(normalizeOptionalString(raw.event));
}

async function resolveMeetingFromParams(params: {
  config: GoogleMeetConfig;
  raw: Record<string, unknown>;
  accessToken: string;
}): Promise<{ meeting: string; calendarEvent?: GoogleMeetCalendarLookupResult }> {
  if (wantsCalendarLookup(params.raw)) {
    const window = params.raw.today === true ? buildGoogleMeetCalendarDayWindow() : {};
    const calendarEvent = await findGoogleMeetCalendarEvent({
      accessToken: params.accessToken,
      calendarId: normalizeOptionalString(params.raw.calendarId),
      eventQuery: normalizeOptionalString(params.raw.event),
      ...window,
    });
    return { meeting: calendarEvent.meetingUri, calendarEvent };
  }
  return { meeting: resolveMeetingInput(params.config, params.raw.meeting) };
}

async function resolveSpaceFromParams(config: GoogleMeetConfig, raw: Record<string, unknown>) {
  const token = await resolveGoogleMeetTokenFromParams(config, raw);
  const { meeting, calendarEvent } = await resolveMeetingFromParams({
    config,
    raw,
    accessToken: token.accessToken,
  });
  const space = await fetchGoogleMeetSpace({
    accessToken: token.accessToken,
    meeting,
  });
  return { meeting, token, space, calendarEvent };
}

async function resolveArtifactQueryFromParams(
  config: GoogleMeetConfig,
  raw: Record<string, unknown>,
) {
  const meeting = normalizeOptionalString(raw.meeting) ?? config.defaults.meeting;
  const conferenceRecord = normalizeOptionalString(raw.conferenceRecord);
  const token = await resolveGoogleMeetTokenFromParams(config, raw);
  const resolvedMeeting: { meeting?: string; calendarEvent?: GoogleMeetCalendarLookupResult } =
    conferenceRecord
      ? { meeting }
      : wantsCalendarLookup(raw)
        ? await resolveMeetingFromParams({ config, raw, accessToken: token.accessToken })
        : { meeting };
  if (!resolvedMeeting.meeting && !conferenceRecord) {
    throw new Error("Meeting input, calendar lookup, or conferenceRecord required");
  }
  return {
    token,
    meeting: resolvedMeeting.meeting,
    calendarEvent: resolvedMeeting.calendarEvent,
    conferenceRecord,
    pageSize: resolveOptionalPositiveInteger(raw.pageSize),
    includeTranscriptEntries: raw.includeTranscriptEntries !== false,
    includeDocumentBodies: raw.includeDocumentBodies === true,
    allConferenceRecords: raw.includeAllConferenceRecords === true,
    mergeDuplicateParticipants: raw.mergeDuplicateParticipants !== false,
    lateAfterMinutes: resolveOptionalPositiveInteger(raw.lateAfterMinutes),
    earlyBeforeMinutes: resolveOptionalPositiveInteger(raw.earlyBeforeMinutes),
  };
}

async function exportGoogleMeetBundleFromParams(
  config: GoogleMeetConfig,
  raw: Record<string, unknown>,
) {
  const resolved = await resolveArtifactQueryFromParams(config, raw);
  const [artifacts, attendance] = await Promise.all([
    fetchGoogleMeetArtifacts({
      accessToken: resolved.token.accessToken,
      meeting: resolved.meeting,
      conferenceRecord: resolved.conferenceRecord,
      pageSize: resolved.pageSize,
      includeTranscriptEntries: resolved.includeTranscriptEntries,
      includeDocumentBodies: resolved.includeDocumentBodies,
      allConferenceRecords: resolved.allConferenceRecords,
    }),
    fetchGoogleMeetAttendance({
      accessToken: resolved.token.accessToken,
      meeting: resolved.meeting,
      conferenceRecord: resolved.conferenceRecord,
      pageSize: resolved.pageSize,
      allConferenceRecords: resolved.allConferenceRecords,
      mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
      lateAfterMinutes: resolved.lateAfterMinutes,
      earlyBeforeMinutes: resolved.earlyBeforeMinutes,
    }),
  ]);
  const { buildGoogleMeetExportManifest, googleMeetExportFileNames, writeMeetExportBundle } =
    await import("./src/cli.js");
  const calendarId = normalizeOptionalString(raw.calendarId);
  const request = {
    ...(resolved.meeting ? { meeting: resolved.meeting } : {}),
    ...(resolved.conferenceRecord ? { conferenceRecord: resolved.conferenceRecord } : {}),
    ...(resolved.calendarEvent?.event.id
      ? { calendarEventId: resolved.calendarEvent.event.id }
      : {}),
    ...(resolved.calendarEvent?.event.summary
      ? { calendarEventSummary: resolved.calendarEvent.event.summary }
      : {}),
    ...(calendarId ? { calendarId } : {}),
    ...(resolved.pageSize !== undefined ? { pageSize: resolved.pageSize } : {}),
    includeTranscriptEntries: resolved.includeTranscriptEntries,
    includeDocumentBodies: resolved.includeDocumentBodies,
    allConferenceRecords: resolved.allConferenceRecords,
    mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
    ...(resolved.lateAfterMinutes !== undefined
      ? { lateAfterMinutes: resolved.lateAfterMinutes }
      : {}),
    ...(resolved.earlyBeforeMinutes !== undefined
      ? { earlyBeforeMinutes: resolved.earlyBeforeMinutes }
      : {}),
  };
  const tokenSource = resolved.token.refreshed ? "refresh-token" : "cached-access-token";
  if (raw.dryRun === true) {
    return {
      dryRun: true,
      manifest: buildGoogleMeetExportManifest({
        artifacts,
        attendance,
        files: googleMeetExportFileNames(),
        request,
        tokenSource,
        ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
      }),
      ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
      tokenSource,
    };
  }
  const outputDir = normalizeOptionalString(raw.outputDir) ?? normalizeOptionalString(raw.output);
  const bundle = await writeMeetExportBundle({
    ...(outputDir ? { outputDir } : {}),
    artifacts,
    attendance,
    zip: raw.zip === true,
    request,
    tokenSource,
    ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
  });
  return {
    ...bundle,
    ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
    tokenSource,
  };
}

export default definePluginEntry({
  id: "google-meet",
  name: "Google Meet",
  description: "Join Google Meet calls through Chrome or Twilio transports",
  configSchema: googleMeetConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = googleMeetConfigSchema.parse(api.pluginConfig);
    let runtime: GoogleMeetRuntime | null = null;

    const ensureRuntime = async () => {
      if (!config.enabled) {
        throw new Error("Google Meet plugin disabled in plugin config");
      }
      if (!runtime) {
        runtime = new GoogleMeetRuntime({
          config,
          fullConfig: api.config,
          runtime: api.runtime,
          logger: api.logger,
        });
      }
      return runtime;
    };

    const formatGatewayError = (err: unknown) =>
      isGoogleMeetBrowserManualActionError(err) ? err.payload : { error: formatErrorMessage(err) };

    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      respond(false, formatGatewayError(err));
    };

    api.registerGatewayMethod(
      "googlemeet.join",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const result = await rt.join({
            url: resolveMeetingInput(config, params?.url),
            transport: normalizeTransport(params?.transport),
            mode: normalizeMode(params?.mode),
            dialInNumber: normalizeOptionalString(params?.dialInNumber),
            pin: normalizeOptionalString(params?.pin),
            dtmfSequence: normalizeOptionalString(params?.dtmfSequence),
            message: normalizeOptionalString(params?.message),
          });
          respond(true, result);
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.create",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asParamRecord(params);
          respond(
            true,
            shouldJoinCreatedMeet(raw)
              ? await createAndJoinMeetFromParams({
                  config,
                  runtime: api.runtime,
                  raw,
                  ensureRuntime,
                })
              : await createMeetFromParams({ config, runtime: api.runtime, raw }),
          );
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(true, rt.status(normalizeOptionalString(params?.sessionId)));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.recoverCurrentTab",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(true, await rt.recoverCurrentTab({ url: normalizeOptionalString(params?.url) }));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.setup",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          respond(true, await rt.setupStatus({ transport: normalizeTransport(params?.transport) }));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.latest",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asParamRecord(params);
          const token = await resolveGoogleMeetTokenFromParams(config, raw);
          const resolved = await resolveMeetingFromParams({
            config,
            raw,
            accessToken: token.accessToken,
          });
          respond(true, {
            ...(await fetchLatestGoogleMeetConferenceRecord({
              accessToken: token.accessToken,
              meeting: resolved.meeting,
            })),
            ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
          });
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.calendarEvents",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asParamRecord(params);
          const token = await resolveGoogleMeetTokenFromParams(config, raw);
          const window = raw.today === true ? buildGoogleMeetCalendarDayWindow() : {};
          respond(
            true,
            await listGoogleMeetCalendarEvents({
              accessToken: token.accessToken,
              calendarId: normalizeOptionalString(raw.calendarId),
              eventQuery: normalizeOptionalString(raw.event),
              ...window,
            }),
          );
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.artifacts",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asParamRecord(params);
          const resolved = await resolveArtifactQueryFromParams(config, raw);
          respond(
            true,
            await fetchGoogleMeetArtifacts({
              accessToken: resolved.token.accessToken,
              meeting: resolved.meeting,
              conferenceRecord: resolved.conferenceRecord,
              pageSize: resolved.pageSize,
              includeTranscriptEntries: resolved.includeTranscriptEntries,
              includeDocumentBodies: resolved.includeDocumentBodies,
              allConferenceRecords: resolved.allConferenceRecords,
            }),
          );
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.attendance",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const raw = asParamRecord(params);
          const resolved = await resolveArtifactQueryFromParams(config, raw);
          respond(
            true,
            await fetchGoogleMeetAttendance({
              accessToken: resolved.token.accessToken,
              meeting: resolved.meeting,
              conferenceRecord: resolved.conferenceRecord,
              pageSize: resolved.pageSize,
              allConferenceRecords: resolved.allConferenceRecords,
              mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
              lateAfterMinutes: resolved.lateAfterMinutes,
              earlyBeforeMinutes: resolved.earlyBeforeMinutes,
            }),
          );
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.export",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          respond(true, await exportGoogleMeetBundleFromParams(config, asParamRecord(params)));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.leave",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const sessionId = normalizeOptionalString(params?.sessionId);
          if (!sessionId) {
            respond(false, { error: "sessionId required" });
            return;
          }
          const rt = await ensureRuntime();
          respond(true, await rt.leave(sessionId));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.speak",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const sessionId = normalizeOptionalString(params?.sessionId);
          if (!sessionId) {
            respond(false, { error: "sessionId required" });
            return;
          }
          const rt = await ensureRuntime();
          respond(true, rt.speak(sessionId, normalizeOptionalString(params?.message)));
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerGatewayMethod(
      "googlemeet.testSpeech",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          const rt = await ensureRuntime();
          const result = await rt.testSpeech({
            url: resolveMeetingInput(config, params?.url),
            transport: normalizeTransport(params?.transport),
            mode: normalizeMode(params?.mode),
            dialInNumber: normalizeOptionalString(params?.dialInNumber),
            pin: normalizeOptionalString(params?.pin),
            dtmfSequence: normalizeOptionalString(params?.dtmfSequence),
            message: normalizeOptionalString(params?.message),
          });
          respond(true, result);
        } catch (err) {
          sendError(respond, err);
        }
      },
    );

    api.registerTool({
      name: "google_meet",
      label: "Google Meet",
      description:
        "Join and track Google Meet sessions through Chrome or Twilio. Call setup_status before join/create/test_speech; if it reports a Chrome node offline or local audio missing, surface that blocker instead of retrying or switching transports. Offline nodes are diagnostics only, not usable candidates. If a Meet tab is already open after a timeout, call recover_current_tab before retrying join to report login, permission, or admission blockers without opening another tab.",
      parameters: GoogleMeetToolSchema,
      async execute(_toolCallId, params) {
        const raw = asParamRecord(params);
        try {
          switch (raw.action) {
            case "join": {
              const rt = await ensureRuntime();
              return json(
                await rt.join({
                  url: resolveMeetingInput(config, raw.url),
                  transport: normalizeTransport(raw.transport),
                  mode: normalizeMode(raw.mode),
                  dialInNumber: normalizeOptionalString(raw.dialInNumber),
                  pin: normalizeOptionalString(raw.pin),
                  dtmfSequence: normalizeOptionalString(raw.dtmfSequence),
                  message: normalizeOptionalString(raw.message),
                }),
              );
            }
            case "create": {
              return json(
                shouldJoinCreatedMeet(raw)
                  ? await createAndJoinMeetFromParams({
                      config,
                      runtime: api.runtime,
                      raw,
                      ensureRuntime,
                    })
                  : await createMeetFromParams({ config, runtime: api.runtime, raw }),
              );
            }
            case "test_speech": {
              const rt = await ensureRuntime();
              return json(
                await rt.testSpeech({
                  url: resolveMeetingInput(config, raw.url),
                  transport: normalizeTransport(raw.transport),
                  mode: normalizeMode(raw.mode),
                  dialInNumber: normalizeOptionalString(raw.dialInNumber),
                  pin: normalizeOptionalString(raw.pin),
                  dtmfSequence: normalizeOptionalString(raw.dtmfSequence),
                  message: normalizeOptionalString(raw.message),
                }),
              );
            }
            case "status": {
              const rt = await ensureRuntime();
              return json(rt.status(normalizeOptionalString(raw.sessionId)));
            }
            case "recover_current_tab": {
              const rt = await ensureRuntime();
              return json(await rt.recoverCurrentTab({ url: normalizeOptionalString(raw.url) }));
            }
            case "setup_status": {
              const rt = await ensureRuntime();
              return json(await rt.setupStatus({ transport: normalizeTransport(raw.transport) }));
            }
            case "resolve_space": {
              const { token: _token, ...result } = await resolveSpaceFromParams(config, raw);
              return json(result);
            }
            case "preflight": {
              const { meeting, token, space } = await resolveSpaceFromParams(config, raw);
              return json(
                buildGoogleMeetPreflightReport({
                  input: meeting,
                  space,
                  previewAcknowledged: config.preview.enrollmentAcknowledged,
                  tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
                }),
              );
            }
            case "latest": {
              const token = await resolveGoogleMeetTokenFromParams(config, raw);
              const resolved = await resolveMeetingFromParams({
                config,
                raw,
                accessToken: token.accessToken,
              });
              return json({
                ...(await fetchLatestGoogleMeetConferenceRecord({
                  accessToken: token.accessToken,
                  meeting: resolved.meeting,
                })),
                ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
              });
            }
            case "calendar_events": {
              const token = await resolveGoogleMeetTokenFromParams(config, raw);
              const window = raw.today === true ? buildGoogleMeetCalendarDayWindow() : {};
              return json(
                await listGoogleMeetCalendarEvents({
                  accessToken: token.accessToken,
                  calendarId: normalizeOptionalString(raw.calendarId),
                  eventQuery: normalizeOptionalString(raw.event),
                  ...window,
                }),
              );
            }
            case "artifacts": {
              const resolved = await resolveArtifactQueryFromParams(config, raw);
              return json(
                await fetchGoogleMeetArtifacts({
                  accessToken: resolved.token.accessToken,
                  meeting: resolved.meeting,
                  conferenceRecord: resolved.conferenceRecord,
                  pageSize: resolved.pageSize,
                  includeTranscriptEntries: resolved.includeTranscriptEntries,
                  includeDocumentBodies: resolved.includeDocumentBodies,
                  allConferenceRecords: resolved.allConferenceRecords,
                }),
              );
            }
            case "attendance": {
              const resolved = await resolveArtifactQueryFromParams(config, raw);
              return json(
                await fetchGoogleMeetAttendance({
                  accessToken: resolved.token.accessToken,
                  meeting: resolved.meeting,
                  conferenceRecord: resolved.conferenceRecord,
                  pageSize: resolved.pageSize,
                  allConferenceRecords: resolved.allConferenceRecords,
                  mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
                  lateAfterMinutes: resolved.lateAfterMinutes,
                  earlyBeforeMinutes: resolved.earlyBeforeMinutes,
                }),
              );
            }
            case "export": {
              return json(await exportGoogleMeetBundleFromParams(config, raw));
            }
            case "leave": {
              const rt = await ensureRuntime();
              const sessionId = normalizeOptionalString(raw.sessionId);
              if (!sessionId) {
                throw new Error("sessionId required");
              }
              return json(await rt.leave(sessionId));
            }
            case "speak": {
              const rt = await ensureRuntime();
              const sessionId = normalizeOptionalString(raw.sessionId);
              if (!sessionId) {
                throw new Error("sessionId required");
              }
              return json(rt.speak(sessionId, normalizeOptionalString(raw.message)));
            }
            default:
              throw new Error("unknown google_meet action");
          }
        } catch (err) {
          return json(formatGatewayError(err));
        }
      },
    });

    api.registerNodeHostCommand({
      command: "googlemeet.chrome",
      cap: "google-meet",
      handle: handleGoogleMeetNodeHostCommand,
    });

    api.registerCli(
      async ({ program }) => {
        const { registerGoogleMeetCli } = await import("./src/cli.js");
        registerGoogleMeetCli({
          program,
          config,
          ensureRuntime,
        });
      },
      {
        commands: ["googlemeet"],
        descriptors: [
          {
            name: "googlemeet",
            description: "Join and manage Google Meet calls",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
