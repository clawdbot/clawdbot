// Shared parent-turn assembler for recently-completed prompt proof.
// Calls prepareEmbeddedAttemptHistory, the production seam that prepends
// subagent prompt context before the model runs.
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AgentSession } from "../../sessions/index.js";
import type { SessionManager } from "../../sessions/session-manager.js";
import type { TranscriptPolicy } from "../../transcript-policy.js";
import { prepareEmbeddedAttemptHistory } from "./attempt-history.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export const PARENT_TURN_BASE_SYSTEM_PROMPT = "Base system prompt";

const transcriptPolicy = {
  sanitizeMode: "full",
  sanitizeToolCallIds: false,
  preserveNativeAnthropicToolUseIds: false,
  repairToolUseResultPairing: false,
  preserveSignatures: false,
  dropThinkingBlocks: false,
  applyGoogleTurnOrdering: false,
  validateGeminiTurns: false,
  validateAnthropicTurns: false,
  allowSyntheticToolResults: true,
} as TranscriptPolicy;

function createActiveSession(): AgentSession {
  const state = { messages: [] };
  return {
    agent: {
      reset() {},
      state,
    },
    get messages() {
      return state.messages;
    },
  } as unknown as AgentSession;
}

function createSessionManager(): SessionManager {
  return {
    getEntries: () => [],
    getBranch: () => [],
    appendCustomEntry() {},
  } as unknown as SessionManager;
}

export async function assembleParentTurnSystemPrompt(params: {
  sessionKey: string;
  sessionAgentId?: string;
  systemPromptText?: string;
}): Promise<string | undefined> {
  let assembled: string | undefined;
  await prepareEmbeddedAttemptHistory({
    attempt: {
      sessionKey: params.sessionKey,
      sessionId: "sess-parent-recent",
      sessionPersistence: "detached",
      config: {} as OpenClawConfig,
      modelId: "sonnet-4.6",
      model: { id: "sonnet-4.6", api: "openai-completions" },
    } as EmbeddedRunAttemptParams,
    activeSession: createActiveSession(),
    sessionManager: createSessionManager(),
    cacheTrace: { recordStage() {} } as never,
    capabilityToolNames: new Set<string>(),
    effectiveWorkspace: process.cwd(),
    isOpenAIResponsesApi: false,
    isRawModelRun: false,
    replayAllowedToolNames: new Set<string>(),
    sandboxed: false,
    sessionAgentId: params.sessionAgentId ?? "main",
    settingsManager: { getCompactionReserveTokens: () => 0 },
    systemPromptText: params.systemPromptText ?? PARENT_TURN_BASE_SYSTEM_PROMPT,
    transcriptPolicy,
    setActiveSessionSystemPrompt(systemPrompt) {
      assembled = systemPrompt;
    },
  });
  return assembled;
}

export function excerptRecentlyCompletedBlock(assembled: string | undefined): string | null {
  if (!assembled) {
    return null;
  }
  const start = assembled.indexOf("## Recently Completed Subagents");
  return start >= 0 ? assembled.slice(start) : null;
}
