import type { AgentEventPayload } from "../../src/infra/agent-events.js";
// Native live fixture setup and capture shared with its offline boundary regressions.
import { createOpenClawTestInstance } from "./openclaw-test-instance.js";

export function createCodexHarnessLiveInstance(
  token: string,
  authMode: "codex-auth" | "api-key" = "codex-auth",
) {
  return createOpenClawTestInstance({
    name: "live-codex-harness",
    // test-env already staged native Codex auth/config in the caller home.
    state: { layout: "state-only" },
    gatewayToken: token,
    env: {
      OPENCLAW_AGENT_RUNTIME: "codex",
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1",
      // Admission and completion must share the normal, built Gateway lifecycle.
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
      OPENAI_API_KEY: authMode === "api-key" ? process.env.OPENAI_API_KEY : undefined,
      OPENAI_BASE_URL:
        authMode === "api-key" && process.env.OPENAI_BASE_URL?.trim()
          ? process.env.OPENAI_BASE_URL
          : undefined,
    },
  });
}

// Full-context assertions consume native usage separately from lifecycle/compaction.
export const CODEX_HARNESS_CONTEXT_EVENT_PREFIXES = [
  "codex_app_server.",
  "compaction",
  "usage",
] as const;

export function createCodexHarnessEventCapture(params: {
  eventPrefix?: string;
  eventPrefixes?: readonly string[];
  includeAllSessions?: boolean;
  sessionKey: string;
}) {
  const events: CapturedAgentEvent[] = [];
  const eventPrefixes = params.eventPrefixes ?? [params.eventPrefix ?? "codex_app_server.guardian"];
  let requestStartedAt = 0;
  let firstAssistantMs: number | undefined;
  return {
    events,
    start(startedAt: number) {
      requestStartedAt = startedAt;
    },
    get firstAssistantMs() {
      return firstAssistantMs;
    },
    onAgentEvent(this: void, event: AgentEventPayload) {
      if (
        !params.includeAllSessions &&
        event.sessionKey &&
        event.sessionKey !== params.sessionKey
      ) {
        return;
      }
      if (event.stream === "assistant" && requestStartedAt > 0 && firstAssistantMs === undefined) {
        firstAssistantMs = Math.max(0, event.ts - requestStartedAt);
      }
      if (!eventPrefixes.some((prefix) => event.stream.startsWith(prefix))) {
        return;
      }
      events.push({
        stream: event.stream,
        sessionKey: event.sessionKey,
        data: event.data,
        ts: event.ts,
      });
    },
  };
}

export type CapturedAgentEvent = {
  stream: string;
  data?: Record<string, unknown>;
  sessionKey?: string;
  ts?: number;
};

export type CodexNativeUsageSnapshot = {
  activeContextTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  inputTokens?: number;
  modelContextWindow: number;
  outputTokens?: number;
  promptTokens: number;
};

export function readCodexNativeUsageSnapshots(
  events: readonly CapturedAgentEvent[],
): CodexNativeUsageSnapshot[] {
  return events.flatMap((event) => {
    if (event.stream !== "usage") {
      return [];
    }
    const activeContextTokens = event.data?.activeContextTokens;
    const modelContextWindow = event.data?.modelContextWindow;
    const promptTokens = event.data?.promptTokens;
    if (
      typeof activeContextTokens !== "number" ||
      typeof modelContextWindow !== "number" ||
      typeof promptTokens !== "number"
    ) {
      return [];
    }
    const optionalNumber = (key: string): number | undefined => {
      const value = event.data?.[key];
      return typeof value === "number" ? value : undefined;
    };
    const cachedInputTokens = optionalNumber("cachedInputTokens");
    const cacheWriteInputTokens = optionalNumber("cacheWriteInputTokens");
    const inputTokens = optionalNumber("inputTokens");
    const outputTokens = optionalNumber("outputTokens");
    return [
      {
        activeContextTokens,
        modelContextWindow,
        promptTokens,
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      },
    ];
  });
}
