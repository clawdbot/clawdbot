/** Generic lifecycle state shared by browser and dial-in meeting sessions. */
export type MeetingSessionState = "active" | "ended";

export type MeetingResolvedJoin<TTransport extends string, TMode extends string> = {
  url: string;
  transport: TTransport;
  mode: TMode;
  agentId: string;
};

export type MeetingTranscriptLine = {
  at?: string;
  speaker?: string;
  text: string;
};

export type MeetingTranscriptSnapshot = {
  droppedLines: number;
  epoch?: string;
  lines: MeetingTranscriptLine[];
};

export type MeetingBrowserTab = {
  targetId: string;
  openedByPlugin: boolean;
};

export type MeetingBrowserCandidateTab = {
  targetId?: string;
  title?: string;
  url?: string;
};

export type MeetingBrowserHealth<
  TManualReason extends string = string,
  TSpeechBlockedReason extends string = string,
> = {
  inCall?: boolean;
  micMuted?: boolean;
  manualActionRequired?: boolean;
  manualActionReason?: TManualReason;
  manualActionMessage?: string;
  speechReady?: boolean;
  speechBlockedReason?: TSpeechBlockedReason;
  speechBlockedMessage?: string;
};

export type MeetingRealtimeSessionBlock = {
  enabled: boolean;
  strategy?: string;
  provider?: string;
  model?: string;
  transcriptionProvider?: string;
  toolPolicy: string;
};

/**
 * Stable shared wire fields. Platform adapters add thin browser and dial-in blocks
 * under their existing public field names so migrations do not reshape JSON.
 */
export type MeetingSessionRecord<
  TTransport extends string = string,
  TMode extends string = string,
  TRealtime extends MeetingRealtimeSessionBlock = MeetingRealtimeSessionBlock,
> = {
  id: string;
  url: string;
  transport: TTransport;
  mode: TMode;
  agentId: string;
  state: MeetingSessionState;
  transcriptEvicted?: boolean;
  browserLeft?: boolean;
  createdAt: string;
  updatedAt: string;
  participantIdentity: string;
  realtime: TRealtime;
  notes: string[];
};
