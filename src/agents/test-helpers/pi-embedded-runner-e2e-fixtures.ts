import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildAttemptReplayMetadata } from "../pi-embedded-runner/run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "../pi-embedded-runner/run/types.js";

export type EmbeddedPiRunnerTestWorkspace = {
  tempRoot: string;
  agentDir: string;
  workspaceDir: string;
};

export async function createEmbeddedPiRunnerTestWorkspace(
  prefix: string,
): Promise<EmbeddedPiRunnerTestWorkspace> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const agentDir = path.join(tempRoot, "agent");
  const workspaceDir = path.join(tempRoot, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  return { tempRoot, agentDir, workspaceDir };
}

export async function cleanupEmbeddedPiRunnerTestWorkspace(
  workspace: EmbeddedPiRunnerTestWorkspace | undefined,
): Promise<void> {
  if (!workspace) {
    return;
  }
  await fs.rm(workspace.tempRoot, { recursive: true, force: true });
}

export function createEmbeddedPiRunnerOpenAiConfig(modelIds: string[]): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: "sk-test",
          baseUrl: "https://example.com",
          models: modelIds.map((id) => ({
            id,
            name: `Mock ${id}`,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 16_000,
            maxTokens: 2048,
          })),
        },
      },
    },
  };
}

export async function immediateEnqueue<T>(task: () => Promise<T>): Promise<T> {
  return await task();
}

export function createMockUsage(input: number, output: number) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

const baseUsage = createMockUsage(0, 0);

export function buildEmbeddedRunnerAssistant(
  overrides: Partial<AssistantMessage>,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "mock-1",
    usage: baseUsage,
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

export function makeEmbeddedRunnerAttempt(
  overrides: Partial<EmbeddedRunAttemptResult>,
): EmbeddedRunAttemptResult {
  const toolMetas = overrides.toolMetas ?? [];
  const didSendViaMessagingTool = overrides.didSendViaMessagingTool ?? false;
  const messagingToolSentTexts = overrides.messagingToolSentTexts ?? [];
  const messagingToolSentMediaUrls = overrides.messagingToolSentMediaUrls ?? [];
  const successfulCronAdds = overrides.successfulCronAdds;
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: "session:test",
    systemPromptReport: undefined,
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas,
    lastAssistant: undefined,
    replayMetadata:
      overrides.replayMetadata ??
      buildAttemptReplayMetadata({
        toolMetas,
        didSendViaMessagingTool,
        messagingToolSentTexts,
        messagingToolSentMediaUrls,
        successfulCronAdds,
      }),
    didSendViaMessagingTool,
    messagingToolSentTexts,
    messagingToolSentMediaUrls,
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    ...overrides,
  };
}

export function createResolvedEmbeddedRunnerModel(
  provider: string,
  modelId: string,
  options?: { baseUrl?: string },
) {
  return {
    model: {
      id: modelId,
      name: modelId,
      api: "openai-responses",
      provider,
      baseUrl: options?.baseUrl ?? `https://example.com/${provider}`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 2048,
    },
    error: undefined,
    authStorage: {
      setRuntimeApiKey: () => undefined,
    },
    modelRegistry: {},
  };
}
