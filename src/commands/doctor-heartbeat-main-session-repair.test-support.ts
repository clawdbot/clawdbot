import type { SessionEntry } from "../config/sessions/types.js";
import "./doctor-heartbeat-main-session-repair.js";

type TranscriptHeartbeatSummary = {
  inspectedMessages: number;
  userMessages: number;
  heartbeatUserMessages: number;
  nonHeartbeatUserMessages: number;
  assistantMessages: number;
  heartbeatOkAssistantMessages: number;
};

type TestApi = {
  TRANSCRIPT_RECORD_MAX_CHARS: number;
  moveHeartbeatMainSessionEntry(params: {
    store: Record<string, SessionEntry>;
    mainKey: string;
    recoveredKey: string;
  }): boolean;
  resolveHeartbeatMainSessionRepairCandidate(params: {
    entry: SessionEntry | undefined;
    transcriptPath?: string;
  }):
    | { reason: "metadata" | "transcript"; summary?: TranscriptHeartbeatSummary }
    | { declineReason: "record-too-large"; reason?: undefined }
    | null;
  summarizeTranscriptHeartbeatMessages(transcriptPath: string): TranscriptHeartbeatSummary | null;
};

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorHeartbeatMainSessionRepairTestApi")
  ] as TestApi;
}

export const getTranscriptRecordMaxChars = (): number => getTestApi().TRANSCRIPT_RECORD_MAX_CHARS;

export const moveHeartbeatMainSessionEntry: TestApi["moveHeartbeatMainSessionEntry"] = (params) =>
  getTestApi().moveHeartbeatMainSessionEntry(params);

export const resolveHeartbeatMainSessionRepairCandidate: TestApi["resolveHeartbeatMainSessionRepairCandidate"] =
  (params) => getTestApi().resolveHeartbeatMainSessionRepairCandidate(params);

export const summarizeTranscriptHeartbeatMessages: TestApi["summarizeTranscriptHeartbeatMessages"] =
  (transcriptPath) => getTestApi().summarizeTranscriptHeartbeatMessages(transcriptPath);
