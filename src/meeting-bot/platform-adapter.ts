import type {
  MeetingBrowserCandidateTab,
  MeetingBrowserHealth,
  MeetingTranscriptSnapshot,
} from "./session-types.js";

export type MeetingManualActionCategory =
  | "login-required"
  | "admission-required"
  | "permission-required"
  | "audio-choice-required"
  | "locale-required"
  | "session-conflict"
  | "browser-control-unavailable"
  | "custom";

export type MeetingManualAction = {
  category: MeetingManualActionCategory;
  reason: string;
  message: string;
};

export type MeetingBrowserRequestParams = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs: number;
};

export type MeetingBrowserRequestCaller = (params: MeetingBrowserRequestParams) => Promise<unknown>;

export type MeetingBrowserJoinSession<Mode extends string> = {
  meetingSessionId: string;
  mode: Mode;
  url: string;
};

export type MeetingBrowserStatusScriptParams<Mode extends string> =
  MeetingBrowserJoinSession<Mode> & {
    autoJoin: boolean;
    captureCaptions: boolean;
    guestName: string;
    readOnly?: boolean;
  };

export type MeetingBrowserLeaveStep = {
  departed: boolean;
  leaveAction?: "leave" | "confirm";
  urlMatched?: boolean;
};

export type MeetingBrowserPermissionPlan = {
  origin: string;
  permissions: string[];
  optionalPermissions?: string[];
};

type MeetingBrowserAdapter<
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
> = {
  allowsMicrophone(mode: Mode): boolean;
  buildStatusJoinScript(params: MeetingBrowserStatusScriptParams<Mode>): string;
  parseStatus(result: unknown): Health | undefined;
  classifyManualAction(health: Health): MeetingManualAction | undefined;
  browserControlUnavailable(error: unknown): MeetingManualAction;
  buildLeaveScript(meetingUrl: string): string;
  parseLeaveResult(result: unknown): MeetingBrowserLeaveStep;
  captions: {
    enabled(mode: Mode): boolean;
    buildTranscriptScript(params: {
      finalize: boolean;
      meetingSessionId: string;
      meetingUrl: string;
    }): string;
    parseTranscript(result: unknown): Transcript & {
      sessionMatched?: boolean;
      urlMatched?: boolean;
    };
  };
  permissions(params: { allowMicrophone: boolean }): MeetingBrowserPermissionPlan | undefined;
  permissionNotes(params: {
    allowMicrophone: boolean;
    error?: unknown;
    result?: unknown;
  }): string[];
};

// The platform owns DOM knowledge and platform wire values. Core owns browser
// lifecycle, polling, and transport mechanics so another meeting plugin can reuse them.
export interface MeetingPlatformAdapter<
  Session,
  Mode extends string,
  Health extends MeetingBrowserHealth,
  Transcript extends MeetingTranscriptSnapshot,
  CreateParams = never,
  CreateResult = never,
  DialInParams = never,
  DialInPlan = never,
> {
  id: string;
  displayName: string;
  browserLabel: string;
  logScope: string;
  nodeCommandName: string;
  nodeConfigPath: string;
  urls: {
    validateAndNormalize(input: unknown): string;
    normalizeForReuse(url: string | undefined): string | undefined;
    isSameMeeting(a: string | undefined, b: string | undefined): boolean;
    buildJoinUrl(session: Session & { url: string }): string;
    accountHint(url: string | undefined): string | undefined;
    isPreferredJoinUrl(url: string | undefined): boolean;
    isRecoverableTab(tab: MeetingBrowserCandidateTab, url?: string): boolean;
    localeAction(tab: MeetingBrowserCandidateTab): MeetingManualAction | undefined;
  };
  browser: MeetingBrowserAdapter<Mode, Health, Transcript>;
  create?: {
    browser(params: CreateParams): Promise<CreateResult>;
  };
  dialIn?: {
    buildPlan(params: DialInParams): DialInPlan;
  };
}
