import type {
  TranscriptSourceProvider,
  TranscriptStartRequest,
  TranscriptsStartResult,
  TranscriptStopRequest,
  TranscriptsStopResult,
} from "../transcripts/provider-types.js";
import type { MeetingSessionRecord, MeetingTranscriptLine } from "./session-types.js";

export type MeetingDurableTranscriptsOptions = {
  config?: unknown;
  providerId: string;
  providerName: string;
  stateDir?: string;
};

export type MeetingTranscriptBridgeLogger = {
  debug?: (message: string) => void;
  warn: (message: string) => void;
};

export type MeetingTranscriptSourceRuntime = {
  startTranscriptSource(request: TranscriptStartRequest): Promise<TranscriptsStartResult>;
  stopTranscriptSource(request: TranscriptStopRequest): Promise<TranscriptsStopResult>;
};

export type MeetingDurableTranscriptBridge<
  TSession extends MeetingSessionRecord = MeetingSessionRecord,
> = {
  readonly enabled: boolean;
  start(session: TSession, capture: () => Promise<void>): Promise<void>;
  ingest(session: TSession, lines: MeetingTranscriptLine[]): Promise<void>;
  stop(session: TSession, finalCapture: () => Promise<void>): Promise<boolean>;
  attach(session: TSession, request: TranscriptStartRequest): Promise<TranscriptsStartResult>;
  detach(request: TranscriptStopRequest): Promise<TranscriptsStopResult>;
};

export function createMeetingTranscriptSourceProvider(params: {
  id: string;
  aliases?: readonly string[];
  name: string;
  runtime: () => Promise<MeetingTranscriptSourceRuntime>;
}): TranscriptSourceProvider {
  return {
    id: params.id,
    aliases: params.aliases,
    name: params.name,
    sourceKinds: ["live-caption"],
    start: async (request) => await (await params.runtime()).startTranscriptSource(request),
    stop: async (request) => await (await params.runtime()).stopTranscriptSource(request),
  };
}
