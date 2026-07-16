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
  moveHeartbeatMainSessionEntry(params: {
    store: Record<string, SessionEntry>;
    mainKey: string;
    recoveredKey: string;
  }): boolean;
  resolveHeartbeatMainSessionRepairCandidate(params: {
    entry: SessionEntry | undefined;
    transcriptPath?: string;
  }): { reason: "metadata" | "transcript"; summary?: TranscriptHeartbeatSummary } | null;
};

function getTestApi(): TestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorHeartbeatMainSessionRepairTestApi")
  ] as TestApi;
}

export const moveHeartbeatMainSessionEntry: TestApi["moveHeartbeatMainSessionEntry"] = (params) =>
  getTestApi().moveHeartbeatMainSessionEntry(params);

export const resolveHeartbeatMainSessionRepairCandidate: TestApi["resolveHeartbeatMainSessionRepairCandidate"] =
  (params) => getTestApi().resolveHeartbeatMainSessionRepairCandidate(params);
