import { formatErrorMessage } from "../infra/errors.js";
import { createMeetingChromeTransport } from "./chrome-transport.js";
import { createMeetingConfiguredNodeHost } from "./node-host.js";
import type {
  MeetingBrowserAdapter,
  MeetingBrowserLeaveStep,
  MeetingManualActionCategory,
  MeetingPlatformAdapter as MeetingPlatformAdapterContract,
  MeetingPlatformRuntimeMetadata,
} from "./platform-adapter-contract.js";
import { createMeetingPluginEntryOptions } from "./plugin-entry.js";
import { createMeetingRuntimeProbes } from "./runtime-probes.js";
import type { MeetingBrowserHealth, MeetingTranscriptSnapshot } from "./session-types.js";
import { createMeetingStatusCallSource } from "./status-call-source.js";
import { createMeetingStatusPreludeSource } from "./status-prejoin-source.js";

export type {
  MeetingBrowserJoinSession,
  MeetingBrowserLeaveStep,
  MeetingBrowserPermissionPlan,
  MeetingBrowserRequestCaller,
  MeetingBrowserRequestParams,
  MeetingBrowserStatusScriptParams,
  MeetingManualAction,
  MeetingManualActionCategory,
} from "./platform-adapter-contract.js";

export interface MeetingPlatformAdapter<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
  CreateParams = never,
  CreateResult = never,
  DialInParams = never,
  DialInPlan = never,
> extends MeetingPlatformAdapterContract<
  Session,
  Mode,
  Health,
  Transcript,
  CreateParams,
  CreateResult,
  DialInParams,
  DialInPlan
> {}

type MeetingPlatformAdapterOptions<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
  CreateParams = never,
  CreateResult = never,
  DialInParams = never,
  DialInPlan = never,
> = Omit<
  MeetingPlatformAdapter<
    Session,
    Mode,
    Health,
    Transcript,
    CreateParams,
    CreateResult,
    DialInParams,
    DialInPlan
  >,
  "agentConsult" | "browser" | "session"
> & {
  agentConsult: MeetingPlatformRuntimeMetadata["agentConsult"];
  browser: Omit<
    MeetingBrowserAdapter<Mode, Health, Transcript>,
    "captions" | "classifyManualAction" | "parseLeaveResult" | "parseStatus" | "permissionNotes"
  > & {
    captions: Omit<MeetingBrowserAdapter<Mode, Health, Transcript>["captions"], "parseTranscript">;
  };
  parsing: {
    classifyManualActionReason(reason: string): MeetingManualActionCategory;
    displayName: string;
    invalidTranscriptMessage: string;
    malformedStatusMessage: string;
    malformedTranscriptMessage: string;
    statusFields?(parsed: Record<string, unknown>): Partial<Health>;
  };
  session: MeetingPlatformRuntimeMetadata["session"];
};

function browserResultString(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const value = (result as Record<string, unknown>).result;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseMeetingBrowserStatus<Health extends MeetingBrowserHealth>(
  result: unknown,
  options: MeetingPlatformAdapterOptions<
    never,
    string,
    Health,
    MeetingTranscriptSnapshot
  >["parsing"],
): Health | undefined {
  const raw = browserResultString(result);
  if (!raw) {
    return undefined;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(options.malformedStatusMessage);
  }
  return {
    inCall: typeof parsed.inCall === "boolean" ? parsed.inCall : undefined,
    micMuted: typeof parsed.micMuted === "boolean" ? parsed.micMuted : undefined,
    cameraOff: typeof parsed.cameraOff === "boolean" ? parsed.cameraOff : undefined,
    lobbyWaiting: typeof parsed.lobbyWaiting === "boolean" ? parsed.lobbyWaiting : undefined,
    captionCaptureRequested:
      typeof parsed.captionCaptureRequested === "boolean"
        ? parsed.captionCaptureRequested
        : undefined,
    captioning: typeof parsed.captioning === "boolean" ? parsed.captioning : undefined,
    captionsEnabledAttempted:
      typeof parsed.captionsEnabledAttempted === "boolean"
        ? parsed.captionsEnabledAttempted
        : undefined,
    transcriptLines:
      typeof parsed.transcriptLines === "number" ? parsed.transcriptLines : undefined,
    lastCaptionAt: typeof parsed.lastCaptionAt === "string" ? parsed.lastCaptionAt : undefined,
    lastCaptionSpeaker:
      typeof parsed.lastCaptionSpeaker === "string" ? parsed.lastCaptionSpeaker : undefined,
    lastCaptionText:
      typeof parsed.lastCaptionText === "string" ? parsed.lastCaptionText : undefined,
    recentTranscript: Array.isArray(parsed.recentTranscript)
      ? parsed.recentTranscript.flatMap((value) => {
          if (!value || typeof value !== "object") {
            return [];
          }
          const line = value as { at?: unknown; speaker?: unknown; text?: unknown };
          if (typeof line.text !== "string" || !line.text.trim()) {
            return [];
          }
          return [
            {
              ...(typeof line.at === "string" ? { at: line.at } : {}),
              ...(typeof line.speaker === "string" ? { speaker: line.speaker } : {}),
              text: line.text,
            },
          ];
        })
      : undefined,
    audioInputRouted:
      typeof parsed.audioInputRouted === "boolean" ? parsed.audioInputRouted : undefined,
    audioInputDeviceLabel:
      typeof parsed.audioInputDeviceLabel === "string" ? parsed.audioInputDeviceLabel : undefined,
    audioInputRouteError:
      typeof parsed.audioInputRouteError === "string" ? parsed.audioInputRouteError : undefined,
    audioOutputRouted:
      typeof parsed.audioOutputRouted === "boolean" ? parsed.audioOutputRouted : undefined,
    audioOutputDeviceLabel:
      typeof parsed.audioOutputDeviceLabel === "string" ? parsed.audioOutputDeviceLabel : undefined,
    audioOutputRouteError:
      typeof parsed.audioOutputRouteError === "string" ? parsed.audioOutputRouteError : undefined,
    audioOutputRouteRetryable:
      typeof parsed.audioOutputRouteRetryable === "boolean"
        ? parsed.audioOutputRouteRetryable
        : undefined,
    manualActionRequired:
      typeof parsed.manualActionRequired === "boolean" ? parsed.manualActionRequired : undefined,
    manualActionReason:
      typeof parsed.manualActionReason === "string" ? parsed.manualActionReason : undefined,
    manualActionMessage:
      typeof parsed.manualActionMessage === "string" ? parsed.manualActionMessage : undefined,
    browserUrl: typeof parsed.url === "string" ? parsed.url : undefined,
    browserTitle: typeof parsed.title === "string" ? parsed.title : undefined,
    status: "browser-control",
    notes: Array.isArray(parsed.notes)
      ? parsed.notes.filter((note): note is string => typeof note === "string")
      : undefined,
    ...options.statusFields?.(parsed),
  } as unknown as Health;
}

function parseMeetingLeaveResult(result: unknown): MeetingBrowserLeaveStep {
  const raw = browserResultString(result);
  if (!raw) {
    return { departed: false };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const leaveAction =
      parsed.leaveAction === "leave" || parsed.leaveAction === "confirm"
        ? parsed.leaveAction
        : undefined;
    return {
      departed: parsed.departed === true,
      ...(leaveAction ? { leaveAction } : {}),
      ...(typeof parsed.sessionConflict === "boolean"
        ? { sessionConflict: parsed.sessionConflict }
        : {}),
      ...(typeof parsed.sessionMatched === "boolean"
        ? { sessionMatched: parsed.sessionMatched }
        : {}),
      ...(typeof parsed.urlMatched === "boolean" ? { urlMatched: parsed.urlMatched } : {}),
    };
  } catch {
    return { departed: false };
  }
}

function parseMeetingTranscript<Transcript extends MeetingTranscriptSnapshot>(
  result: unknown,
  options: MeetingPlatformAdapterOptions<
    never,
    string,
    MeetingBrowserHealth,
    Transcript
  >["parsing"],
): Transcript & { sessionMatched?: boolean; urlMatched?: boolean } {
  const raw = browserResultString(result);
  if (!raw) {
    return { droppedLines: 0, lines: [] } as unknown as Transcript;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(options.malformedTranscriptMessage);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(options.invalidTranscriptMessage);
  }
  const payload = parsed as {
    droppedLines?: unknown;
    epoch?: unknown;
    lines?: unknown;
    sessionMatched?: unknown;
    urlMatched?: unknown;
  };
  const droppedLines =
    typeof payload.droppedLines === "number" && Number.isSafeInteger(payload.droppedLines)
      ? Math.max(0, payload.droppedLines)
      : 0;
  const lines = Array.isArray(payload.lines)
    ? payload.lines.flatMap((value) => {
        if (!value || typeof value !== "object") {
          return [];
        }
        const line = value as { at?: unknown; speaker?: unknown; text?: unknown };
        if (typeof line.text !== "string" || !line.text.trim()) {
          return [];
        }
        return [
          {
            ...(typeof line.at === "string" ? { at: line.at } : {}),
            ...(typeof line.speaker === "string" ? { speaker: line.speaker } : {}),
            text: line.text,
          },
        ];
      })
    : [];
  return {
    droppedLines,
    ...(typeof payload.epoch === "string" ? { epoch: payload.epoch } : {}),
    lines,
    ...(typeof payload.urlMatched === "boolean" ? { urlMatched: payload.urlMatched } : {}),
    ...(typeof payload.sessionMatched === "boolean"
      ? { sessionMatched: payload.sessionMatched }
      : {}),
  } as Transcript & { sessionMatched?: boolean; urlMatched?: boolean };
}

function createMeetingPlatformAdapter<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
  CreateParams = never,
  CreateResult = never,
  DialInParams = never,
  DialInPlan = never,
>(
  options: MeetingPlatformAdapterOptions<
    Session,
    Mode,
    Health,
    Transcript,
    CreateParams,
    CreateResult,
    DialInParams,
    DialInPlan
  >,
): MeetingPlatformAdapter<
  Session,
  Mode,
  Health,
  Transcript,
  CreateParams,
  CreateResult,
  DialInParams,
  DialInPlan
> &
  MeetingPlatformRuntimeMetadata {
  const { browser, parsing, ...platform } = options;
  return {
    ...platform,
    browser: {
      ...browser,
      parseStatus: (result) => parseMeetingBrowserStatus(result, parsing),
      classifyManualAction: (health) => {
        if (
          !health.manualActionRequired ||
          !health.manualActionReason ||
          !health.manualActionMessage
        ) {
          return undefined;
        }
        return {
          category: parsing.classifyManualActionReason(health.manualActionReason),
          reason: health.manualActionReason,
          message: health.manualActionMessage,
        };
      },
      parseLeaveResult: parseMeetingLeaveResult,
      captions: {
        ...browser.captions,
        parseTranscript: (result) => parseMeetingTranscript(result, parsing),
      },
      permissionNotes: ({ allowMicrophone, error, result }) => {
        if (!allowMicrophone) {
          return [`Observe-only mode does not request ${parsing.displayName} microphone access.`];
        }
        if (error) {
          return [
            `Could not grant ${parsing.displayName} media permissions automatically: ${formatErrorMessage(error)}`,
          ];
        }
        const record =
          result && typeof result === "object" ? (result as Record<string, unknown>) : {};
        const unsupportedPermissions = Array.isArray(record.unsupportedPermissions)
          ? record.unsupportedPermissions.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        const notes = [
          `Granted ${parsing.displayName} microphone permission through browser control.`,
        ];
        if (unsupportedPermissions.includes("speakerSelection")) {
          notes.push(
            `Chrome did not accept the optional ${parsing.displayName} speaker-selection permission.`,
          );
        }
        return notes;
      },
    },
  };
}

export const MeetingPlatformAdapter = {
  create: createMeetingPlatformAdapter,
  createChromeTransport: createMeetingChromeTransport,
  createRuntimeProbes: createMeetingRuntimeProbes,
  createNodeHostHandler: createMeetingConfiguredNodeHost,
  createPluginEntry: createMeetingPluginEntryOptions,
  createStatusCallSource: createMeetingStatusCallSource,
  createStatusPreludeSource: createMeetingStatusPreludeSource,
};
