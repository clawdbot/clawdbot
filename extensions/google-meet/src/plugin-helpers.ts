import { readPositiveIntegerParam } from "openclaw/plugin-sdk/channel-actions";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  callGatewayFromCli,
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildGoogleMeetCalendarDayWindow,
  findGoogleMeetCalendarEvent,
  type GoogleMeetCalendarLookupResult,
} from "./calendar.js";
import {
  resolveGoogleMeetGatewayOperationTimeoutMs,
  type GoogleMeetConfig,
  type GoogleMeetMode,
  type GoogleMeetTransport,
} from "./config.js";
import {
  fetchGoogleMeetArtifacts,
  fetchGoogleMeetAttendance,
  fetchGoogleMeetSpace,
} from "./meet.js";
import { GoogleMeetRuntime } from "./runtime.js";
import { isGoogleMeetBrowserManualActionError } from "./transports/chrome-create.js";

const loadGoogleMeetCreateModule = createLazyRuntimeModule(() => import("./create.js"));

export const loadGoogleMeetCliModule = createLazyRuntimeModule(() => import("./cli.js"));

export function asParamRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

export function normalizeTransport(value: unknown): GoogleMeetTransport | undefined {
  return value === "chrome" || value === "chrome-node" || value === "twilio" ? value : undefined;
}

export function normalizeMode(value: unknown): GoogleMeetMode | undefined {
  if (value === "realtime") {
    return "agent";
  }
  return value === "agent" || value === "bidi" || value === "transcribe" ? value : undefined;
}

function isGoogleMeetTalkBackMode(mode: GoogleMeetMode): boolean {
  return mode === "agent" || mode === "bidi";
}

export function resolveMeetingInput(config: GoogleMeetConfig, value: unknown): string {
  const meeting = normalizeOptionalString(value) ?? config.defaults.meeting;
  if (!meeting) {
    throw new Error("Meeting input is required");
  }
  return meeting;
}

export function shouldJoinCreatedMeet(raw: Record<string, unknown>): boolean {
  return raw.join !== false && raw.join !== "false";
}

const googleMeetToolDeps = {
  callGatewayFromCli,
  platform: () => process.platform,
};

export const testing = {
  setCallGatewayFromCliForTests(next?: typeof callGatewayFromCli): void {
    googleMeetToolDeps.callGatewayFromCli = next ?? callGatewayFromCli;
  },
  setPlatformForTests(next?: () => NodeJS.Platform): void {
    googleMeetToolDeps.platform = next ?? (() => process.platform);
  },
  isGoogleMeetAgentToolActionUnsupportedOnHost,
  resolveGoogleMeetGatewayOperationTimeoutMs,
};

type GoogleMeetGatewayToolAction =
  | "join"
  | "create"
  | "status"
  | "transcript"
  | "recover_current_tab"
  | "setup_status"
  | "leave"
  | "end_active_conference"
  | "speak"
  | "test_speech"
  | "test_listen";

function googleMeetGatewayMethodForToolAction(action: GoogleMeetGatewayToolAction): string {
  switch (action) {
    case "recover_current_tab":
      return "googlemeet.recoverCurrentTab";
    case "setup_status":
      return "googlemeet.setup";
    case "test_speech":
      return "googlemeet.testSpeech";
    case "test_listen":
      return "googlemeet.testListen";
    case "end_active_conference":
      return "googlemeet.endActiveConference";
    default:
      return `googlemeet.${action}`;
  }
}

function isGoogleMeetAgentToolActionUnsupportedOnHost(params: {
  config: GoogleMeetConfig;
  raw: Record<string, unknown>;
  platform?: NodeJS.Platform;
}): boolean {
  const platform = params.platform ?? googleMeetToolDeps.platform();
  if (platform === "darwin") {
    return false;
  }
  const action = params.raw.action;
  if (
    action !== "join" &&
    action !== "test_speech" &&
    !(action === "create" && shouldJoinCreatedMeet(params.raw))
  ) {
    return false;
  }
  const transport = normalizeTransport(params.raw.transport) ?? params.config.defaultTransport;
  const mode =
    action === "test_speech"
      ? "agent"
      : (normalizeMode(params.raw.mode) ?? params.config.defaultMode);
  return transport === "chrome" && isGoogleMeetTalkBackMode(mode);
}

export function assertGoogleMeetAgentToolActionSupported(params: {
  config: GoogleMeetConfig;
  raw: Record<string, unknown>;
}): void {
  if (!isGoogleMeetAgentToolActionUnsupportedOnHost(params)) {
    return;
  }
  throw new Error(
    "Google Meet local Chrome talk-back audio is macOS-only. On this host, use mode: transcribe, transport: twilio, or transport: chrome-node backed by a macOS node.",
  );
}

function readGatewayErrorDetails(err: unknown): unknown {
  if (!err || typeof err !== "object" || !("details" in err)) {
    return undefined;
  }
  return (err as { details?: unknown }).details;
}

export async function callGoogleMeetGatewayFromTool(params: {
  config: GoogleMeetConfig;
  action: GoogleMeetGatewayToolAction;
  raw: Record<string, unknown>;
  runtime?: OpenClawPluginApi["runtime"];
}): Promise<unknown> {
  try {
    if (params.runtime) {
      return await params.runtime.gateway.request(
        googleMeetGatewayMethodForToolAction(params.action),
        params.raw,
        {
          timeoutMs: resolveGoogleMeetGatewayOperationTimeoutMs(params.config),
          scopes: ["operator.admin"],
        },
      );
    }
    // Standalone agent workers connect as this bundled plugin, not as the
    // model session; its Gateway methods remain the only exposed actions.
    return await googleMeetToolDeps.callGatewayFromCli(
      googleMeetGatewayMethodForToolAction(params.action),
      {
        json: true,
        timeout: String(resolveGoogleMeetGatewayOperationTimeoutMs(params.config)),
      },
      params.raw,
      { progress: false, scopes: ["operator.admin"] },
    );
  } catch (err) {
    const details = readGatewayErrorDetails(err);
    if (details && typeof details === "object") {
      return details;
    }
    throw err;
  }
}

export function keepTrustedToolAgentId(
  raw: Record<string, unknown>,
  client: GatewayRequestHandlerOptions["client"],
): Record<string, unknown> {
  const { agentId: rawAgentId, ...rest } = raw;
  if (client?.internal?.pluginRuntimeOwnerId !== "google-meet") {
    return rest;
  }
  const agentId = normalizeOptionalString(rawAgentId);
  return agentId ? { ...rest, agentId } : rest;
}

export async function createMeetFromParams(params: {
  config: GoogleMeetConfig;
  runtime: OpenClawPluginApi["runtime"];
  raw: Record<string, unknown>;
}) {
  const create = await loadGoogleMeetCreateModule();
  return create.createMeetFromParams(params);
}

export async function createAndJoinMeetFromParams(params: {
  config: GoogleMeetConfig;
  runtime: OpenClawPluginApi["runtime"];
  raw: Record<string, unknown>;
  ensureRuntime: () => Promise<GoogleMeetRuntime>;
}) {
  const create = await loadGoogleMeetCreateModule();
  return create.createAndJoinMeetFromParams(params);
}

export async function resolveGoogleMeetTokenFromParams(
  config: GoogleMeetConfig,
  raw: Record<string, unknown>,
) {
  const { resolveGoogleMeetAccessToken } = await import("./oauth.js");
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

export async function resolveMeetingFromParams(params: {
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

export async function resolveSpaceFromParams(
  config: GoogleMeetConfig,
  raw: Record<string, unknown>,
) {
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

export async function resolveArtifactQueryFromParams(
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
    pageSize: readPositiveIntegerParam(raw, "pageSize"),
    includeTranscriptEntries: raw.includeTranscriptEntries !== false,
    includeDocumentBodies: raw.includeDocumentBodies === true,
    allConferenceRecords: raw.includeAllConferenceRecords === true,
    mergeDuplicateParticipants: raw.mergeDuplicateParticipants !== false,
    lateAfterMinutes: readPositiveIntegerParam(raw, "lateAfterMinutes"),
    earlyBeforeMinutes: readPositiveIntegerParam(raw, "earlyBeforeMinutes"),
  };
}

export async function exportGoogleMeetBundleFromParams(
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
    await loadGoogleMeetCliModule();
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
export function createGoogleMeetRuntimeAccessor(params: {
  api: OpenClawPluginApi;
  config: GoogleMeetConfig;
}): () => Promise<GoogleMeetRuntime> {
  let runtime: GoogleMeetRuntime | null = null;
  return async () => {
    if (!params.config.enabled) {
      throw new Error("Google Meet plugin disabled in plugin config");
    }
    if (!runtime) {
      runtime = new GoogleMeetRuntime({
        config: params.config,
        fullConfig: params.api.config,
        runtime: params.api.runtime,
        logger: params.api.logger,
      });
    }
    return runtime;
  };
}

export function formatGoogleMeetGatewayError(err: unknown) {
  return isGoogleMeetBrowserManualActionError(err)
    ? err.payload
    : { error: formatErrorMessage(err) };
}

export function sendGoogleMeetGatewayError(
  respond: GatewayRequestHandlerOptions["respond"],
  err: unknown,
  code: Parameters<typeof errorShape>[0] = ErrorCodes.UNAVAILABLE,
): void {
  const payload = formatGoogleMeetGatewayError(err);
  respond(
    false,
    payload,
    errorShape(
      code,
      typeof payload.error === "string" ? payload.error : "Google Meet request failed",
      {
        details: payload,
      },
    ),
  );
}
