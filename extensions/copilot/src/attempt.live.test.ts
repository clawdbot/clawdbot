// Copilot tests cover attempt plugin behavior.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import type { SessionConfig } from "@github/copilot-sdk";
import type { AgentHarnessAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it, vi } from "vitest";
import { createCopilotAgentHarness } from "../harness.js";
import type { CopilotClientPool } from "./runtime.js";

const liveToolState = vi.hoisted(() => ({
  calls: [] as string[],
  expectedText: "phase-1-green",
  permissionRequests: 0,
  sentinelPrefix: "copilot-live-smoke:",
  toolName: "live_echo",
  userInputRequests: 0,
}));

const LIVE_MODEL_PREFERENCES = ["gpt-5.4-mini", "gpt-5.4", "gpt-5.6-luna"] as const;

vi.mock("openclaw/plugin-sdk/agent-harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness")>();

  return {
    ...actual,
    createOpenClawCodingTools: vi.fn(() => [
      {
        name: liveToolState.toolName,
        label: liveToolState.toolName,
        description: "Echo the requested text for the copilot live smoke test.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              description: "Text to echo back to the model.",
            },
          },
          required: ["text"],
        },
        async execute(_toolCallId: string, params: unknown) {
          const textInput =
            params && typeof params === "object" && !Array.isArray(params)
              ? (params as { text?: unknown }).text
              : undefined;
          const text = typeof textInput === "string" ? textInput : "";
          const echoed = `${liveToolState.sentinelPrefix}${text}`;
          liveToolState.calls.push(text);
          console.info(
            `[copilot-live-smoke] ${liveToolState.toolName} ${JSON.stringify({ echoed, text })}`,
          );
          return {
            content: [{ type: "text", text: echoed }],
            details: { echoed },
          };
        },
      },
    ]),
  };
});

const LIVE = isLiveTestEnabled(["OPENCLAW_COPILOT_AGENT_LIVE_TEST"]);
const TOKEN =
  process.env.OPENCLAW_COPILOT_AGENT_LIVE_TOKEN ||
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  "";
const describeLive = LIVE && TOKEN ? describe : describe.skip;

function wrapLiveSessionConfig(config: SessionConfig): SessionConfig {
  const onPermissionRequest = config.onPermissionRequest;
  const onUserInputRequest = config.onUserInputRequest;
  return {
    ...config,
    ...(onPermissionRequest
      ? {
          onPermissionRequest: async (...args: Parameters<typeof onPermissionRequest>) => {
            liveToolState.permissionRequests += 1;
            return onPermissionRequest(...args);
          },
        }
      : {}),
    ...(onUserInputRequest
      ? {
          onUserInputRequest: async (...args: Parameters<typeof onUserInputRequest>) => {
            liveToolState.userInputRequests += 1;
            return onUserInputRequest(...args);
          },
        }
      : {}),
  };
}

function createLivePool(): CopilotClientPool {
  const activeClients = new Set<CopilotClient>();

  return {
    async acquire(key, options) {
      const { copilotHome, ...clientOptions } = options;
      const client = new CopilotClient({ ...clientOptions, baseDirectory: copilotHome });
      activeClients.add(client);
      return {
        key,
        client: {
          createSession: (config: Parameters<CopilotClient["createSession"]>[0]) =>
            client.createSession(wrapLiveSessionConfig(config)),
          resumeSession: (
            sessionId: Parameters<CopilotClient["resumeSession"]>[0],
            config: Parameters<CopilotClient["resumeSession"]>[1],
          ) => client.resumeSession(sessionId, wrapLiveSessionConfig(config)),
          stop: () => client.stop(),
        } as unknown as CopilotClient,
      };
    },
    async dispose() {
      const errors: Error[] = [];
      for (const client of activeClients) {
        try {
          errors.push(...(await client.stop()));
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      activeClients.clear();
      return errors;
    },
    async release() {},
    size() {
      return activeClients.size;
    },
  };
}

async function resolveLiveModelId(copilotHome: string): Promise<string> {
  const client = new CopilotClient({ baseDirectory: copilotHome, gitHubToken: TOKEN });
  try {
    await client.start();
    const available = (await client.listModels()).filter(
      (model) => model.policy?.state !== "disabled",
    );
    for (const preferred of LIVE_MODEL_PREFERENCES) {
      if (available.some((model) => model.id === preferred)) {
        return preferred;
      }
    }
    const fallback = available[0]?.id;
    if (!fallback) {
      throw new Error("Copilot live smoke found no enabled models");
    }
    return fallback;
  } finally {
    await client.stop();
  }
}

function createAttemptParams(params: {
  copilotHome: string;
  modelId: string;
  onAgentEvent?: (event: unknown) => void | Promise<void>;
  onAssistantDelta: (payload: { text: string }) => void | Promise<void>;
  prompt: string;
}): AgentHarnessAttemptParams {
  const profileId = "live-smoke-profile";
  const profileVersion = "v1";
  const now = Date.now();

  return {
    agentDir: params.copilotHome,
    agentId: "copilot-live-smoke",
    auth: {
      gitHubToken: TOKEN,
      profileId,
      profileVersion,
    },
    authProfileId: profileId,
    copilotHome: params.copilotHome,
    cwd: process.cwd(),
    messages: [{ content: params.prompt, role: "user", timestamp: now }],
    model: {
      api: "openai-responses",
      id: params.modelId,
      provider: "github-copilot",
    },
    modelId: params.modelId,
    onAgentEvent: params.onAgentEvent,
    onAssistantDelta: params.onAssistantDelta,
    profileVersion,
    prompt: params.prompt,
    provider: "github-copilot",
    runId: `copilot-live-smoke-${now}`,
    sessionFile: join(params.copilotHome, "copilot-live-smoke.session.json"),
    sessionId: `copilot-live-smoke-session-${now}`,
    timeoutMs: 90_000,
    workspaceDir: process.cwd(),
  } as unknown as AgentHarnessAttemptParams;
}

describeLive("copilot agent runtime live smoke", () => {
  it("uses one custom tool, then resumes with an isolated finalization turn", async () => {
    liveToolState.calls.length = 0;
    liveToolState.permissionRequests = 0;
    liveToolState.userInputRequests = 0;
    const streamedTexts: string[] = [];
    const finalEventTypes: string[] = [];
    const prompt = `Use the ${liveToolState.toolName} tool exactly once with text '${liveToolState.expectedText}', then reply with one short sentence.`;
    const copilotHome = await mkdtemp(join(tmpdir(), "openclaw-copilot-live-"));
    const modelId = await resolveLiveModelId(copilotHome);
    const harness = createCopilotAgentHarness({ pool: createLivePool() });

    try {
      expect(
        harness.supports({
          provider: "github-copilot",
          modelId,
          requestedRuntime: "copilot",
        }),
      ).toEqual({ supported: true, priority: 100 });

      const attempt = createAttemptParams({
        copilotHome,
        modelId,
        onAssistantDelta: ({ text }) => {
          if (text.trim()) {
            streamedTexts.push(text);
          }
        },
        prompt,
      });
      const settledResult = await harness.runAttempt(attempt);
      const matchingCalls = liveToolState.calls.filter(
        (text) => text === liveToolState.expectedText,
      );
      expect(settledResult.promptError).toBeUndefined();
      expect(settledResult.timedOut).toBe(false);
      expect(matchingCalls).toHaveLength(1);
      expect(
        settledResult.toolMetas.some(
          (toolMeta) =>
            toolMeta.toolName === liveToolState.toolName &&
            toolMeta.meta?.includes(liveToolState.sentinelPrefix),
        ),
      ).toBe(true);

      const finalPrompt = "Reply with exactly COPILOT-SETTLED-FINALIZER-OK and nothing else.";
      const finalResult = await harness.finalizeSettledTurn?.({
        attempt: {
          ...attempt,
          onAgentEvent: (event: unknown) => {
            const type = (event as { type?: unknown } | undefined)?.type;
            if (typeof type === "string") {
              finalEventTypes.push(type);
            }
          },
          prompt: finalPrompt,
          runId: `${attempt.runId}-finalize`,
        },
        settledAttempt: settledResult,
      });
      if (!finalResult) {
        throw new Error("Copilot harness did not expose settled tool finalization");
      }
      const assistantText = finalResult.assistant.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n")
        .trim();
      const finalCapabilityEvents = finalEventTypes.filter((type) =>
        /(tool|permission|user.?input|subagent)/i.test(type),
      );

      console.info(
        "[copilot-live-smoke] summary",
        JSON.stringify(
          {
            assistantText,
            finalCapabilityEvents,
            finalEventTypes,
            modelId,
            permissionRequests: liveToolState.permissionRequests,
            toolCalls: liveToolState.calls,
            streamedTexts,
            toolMetas: settledResult.toolMetas,
            usage: finalResult.usage,
            userInputRequests: liveToolState.userInputRequests,
          },
          null,
          2,
        ),
      );

      expect(assistantText).toBe("COPILOT-SETTLED-FINALIZER-OK");
      expect(liveToolState.calls).toEqual([liveToolState.expectedText]);
      expect(finalResult.assistant.stopReason).not.toBe("toolUse");
      expect(finalResult.assistant.content.every((block) => block.type !== "toolCall")).toBe(true);
      expect(finalResult).not.toHaveProperty("toolMetas");
      expect(finalCapabilityEvents).toEqual([]);
      expect(liveToolState.permissionRequests).toBe(0);
      expect(liveToolState.userInputRequests).toBe(0);
    } finally {
      await harness.dispose?.();
      await rm(copilotHome, { recursive: true, force: true });
    }
  }, 180_000);
});
