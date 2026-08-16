import { vi } from "vitest";
import {
  handleAgentEvent,
  type FallbackStatus,
  type PlanStatus,
  type ToolStreamEntry,
} from "./tool-stream.ts";

type ToolStreamHost = Parameters<typeof handleAgentEvent>[0];
type AgentEvent = NonNullable<Parameters<typeof handleAgentEvent>[1]>;
type MutableHost = ToolStreamHost & {
  sessions: {
    state: { modelOverrides: Record<string, string | null> };
    setModelOverride: (key: string, value: string | null | undefined) => void;
  };
  compactionStatus?: unknown;
  compactionClearTimer?: number | null;
  fallbackStatus?: FallbackStatus | null;
  fallbackClearTimer?: number | null;
  planStatus?: PlanStatus | null;
  requestUpdate?: () => void;
};

export const TOOL_STREAM_TEST_NOW = new Date("2026-05-09T00:00:00.000Z").getTime();

export function createHost(overrides?: Partial<MutableHost>): MutableHost {
  const modelOverrides: Record<string, string | null> = {};
  return {
    sessionKey: "main",
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunStartup: null,
    chatStreamSegments: [],
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    chatToolMessages: [],
    toolStreamSyncTimer: null,
    sessions: {
      state: { modelOverrides },
      setModelOverride: (key, value) => {
        if (value === undefined) {
          delete modelOverrides[key];
        } else {
          modelOverrides[key] = value;
        }
      },
    },
    compactionStatus: null,
    compactionClearTimer: null,
    fallbackStatus: null,
    fallbackClearTimer: null,
    planStatus: null,
    ...overrides,
  };
}

export function agentEvent(
  runId: string,
  seq: number,
  stream: AgentEvent["stream"],
  data: AgentEvent["data"],
  sessionKey = "main",
): AgentEvent {
  return {
    runId,
    seq,
    stream,
    ts: Date.now(),
    sessionKey,
    data,
  };
}

export function useToolStreamFakeTimers(): void {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(TOOL_STREAM_TEST_NOW);
}
