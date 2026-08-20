// Copilot tests cover attempt plugin behavior.
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import type { SessionConfig } from "@github/copilot-sdk";
import type {
  AgentMessage,
  AgentHarnessAttemptParamsV2 as AgentHarnessAttemptParams,
  AgentHarnessV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createCopilotAgentHarness } from "../harness.js";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";

type SettledTurnFinalizationAttemptParams = Parameters<
  NonNullable<AgentHarnessV2["finalizeSettledTurn"]>
>[0]["attempt"];
import type { CopilotClientPool } from "./runtime.js";

const liveToolState = vi.hoisted(() => ({
  calls: [] as string[],
  expectedText: "phase-1-green",
  permissionRequests: 0,
  sentinelPrefix: "copilot-live-smoke:",
  spawnCalls: [] as Array<{ task: string; visible: boolean }>,
  spawnToolName: "sessions_spawn",
  toolName: "live_echo",
  userInputRequests: 0,
}));

const LIVE_MODEL_PREFERENCES = ["gpt-5.4-mini", "gpt-5.4", "gpt-5.6-luna"] as const;
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_DEFAULT_MODEL = "gpt-5.6-luna";
const OPENAI_AUTH_PROFILE_ID = "openai:copilot-agent-live";

type LiveAuthMode =
  | { kind: "github-copilot"; gitHubToken: string }
  | { apiKey: string; kind: "openai-byok"; modelId: string };

type LiveAttemptFacts =
  | {
      auth: { gitHubToken: string; profileId: string; profileVersion: string };
      authProfileId: string;
      kind: "github-copilot";
      model: { api: "openai-responses"; id: string; provider: "github-copilot" };
      provider: "github-copilot";
    }
  | {
      authProfileId: string;
      kind: "openai-byok";
      model: {
        api: "openai-responses";
        baseUrl: typeof OPENAI_BASE_URL;
        id: string;
        provider: "openai";
      };
      provider: "openai";
      resolvedApiKey: string;
    };

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
      {
        name: liveToolState.spawnToolName,
        label: liveToolState.spawnToolName,
        description: "Spawn an OpenClaw session for delegated work.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            task: { type: "string", description: "The delegated objective." },
            visible: {
              type: "boolean",
              description: "Whether the user can follow the session in the sidebar.",
            },
          },
          required: ["task"],
        },
        async execute(_toolCallId: string, params: unknown) {
          const input =
            params && typeof params === "object" && !Array.isArray(params)
              ? (params as { task?: unknown; visible?: unknown })
              : {};
          const call = {
            task: typeof input.task === "string" ? input.task : "",
            visible: input.visible === true,
          };
          liveToolState.spawnCalls.push(call);
          return {
            content: [
              {
                type: "text",
                text: "Visible delegated session created: https://example.test/session/live-proof",
              },
            ],
            details: {
              sessionKey: "agent:copilot-live-smoke:subagent:live-proof",
              url: "https://example.test/session/live-proof",
              visible: call.visible,
            },
          };
        },
      },
    ]),
  };
});

const LIVE = isLiveTestEnabled(["OPENCLAW_COPILOT_AGENT_LIVE_TEST"]);
const AUTH_MODE = resolveLiveAuthMode();
const describeLive = LIVE && AUTH_MODE ? describe : describe.skip;
let liveAttemptFacts: LiveAttemptFacts;

function readNonEmptyEnv(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() ? value : undefined;
}

function resolveLiveAuthMode(): LiveAuthMode | undefined {
  const explicitCopilotToken = readNonEmptyEnv("OPENCLAW_COPILOT_AGENT_LIVE_TOKEN");
  if (explicitCopilotToken) {
    return { kind: "github-copilot", gitHubToken: explicitCopilotToken };
  }
  const apiKey = readNonEmptyEnv("OPENAI_API_KEY");
  if (apiKey) {
    return {
      apiKey,
      kind: "openai-byok",
      modelId: readNonEmptyEnv("OPENCLAW_COPILOT_AGENT_LIVE_MODEL") ?? OPENAI_DEFAULT_MODEL,
    };
  }
  const fallbackCopilotToken = readNonEmptyEnv("GITHUB_TOKEN") ?? readNonEmptyEnv("GH_TOKEN");
  return fallbackCopilotToken
    ? { kind: "github-copilot", gitHubToken: fallbackCopilotToken }
    : undefined;
}

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

async function resolveLiveAttemptFacts(
  authMode: LiveAuthMode,
  copilotHome: string,
): Promise<LiveAttemptFacts> {
  if (authMode.kind === "openai-byok") {
    return {
      authProfileId: OPENAI_AUTH_PROFILE_ID,
      kind: authMode.kind,
      model: {
        api: "openai-responses",
        baseUrl: OPENAI_BASE_URL,
        id: authMode.modelId,
        provider: "openai",
      },
      provider: "openai",
      resolvedApiKey: authMode.apiKey,
    };
  }

  const client = new CopilotClient({
    baseDirectory: copilotHome,
    gitHubToken: authMode.gitHubToken,
  });
  try {
    await client.start();
    const available = (await client.listModels()).filter(
      (model) => model.policy?.state !== "disabled",
    );
    for (const preferred of LIVE_MODEL_PREFERENCES) {
      if (available.some((model) => model.id === preferred)) {
        return createGitHubAttemptFacts(authMode.gitHubToken, preferred);
      }
    }
    const fallback = available[0]?.id;
    if (!fallback) {
      throw new Error("Copilot live smoke found no enabled models");
    }
    return createGitHubAttemptFacts(authMode.gitHubToken, fallback);
  } finally {
    await client.stop();
  }
}

function createGitHubAttemptFacts(gitHubToken: string, modelId: string): LiveAttemptFacts {
  const profileId = "live-smoke-profile";
  return {
    auth: { gitHubToken, profileId, profileVersion: "v1" },
    authProfileId: profileId,
    kind: "github-copilot",
    model: { api: "openai-responses", id: modelId, provider: "github-copilot" },
    provider: "github-copilot",
  };
}

function createLiveUserTurnRecorder(
  message: Extract<AgentMessage, { role: "user" }>,
): NonNullable<AgentHarnessAttemptParams["userTurnTranscriptRecorder"]> {
  let blocked = false;
  let persisted = false;
  return {
    message,
    resolveMessage: async () => message,
    markRuntimePersistencePending() {},
    markRuntimePersisted() {
      persisted = true;
    },
    markBlocked() {
      blocked = true;
    },
    hasPersisted: () => persisted,
    isBlocked: () => blocked,
    hasRuntimePersistencePending: () => false,
    getAdmissionReceipt: () => undefined,
    waitForRuntimePersistence: async () => undefined,
    persistApproved: async () => undefined,
    persistBlocked: async () => undefined,
    persistFallback: async () => undefined,
  };
}

async function createTempDir(prefix: string): Promise<string> {
  return await mkdtemp(join(await realpath(tmpdir()), prefix));
}

async function createAttemptParams(params: {
  copilotHome: string;
  facts: LiveAttemptFacts;
  onAgentEvent?: (event: unknown) => void | Promise<void>;
  onAssistantDelta: (payload: { text: string }) => void | Promise<void>;
  prompt: string;
}): Promise<AgentHarnessAttemptParams> {
  const profileVersion = "v1";
  const now = Date.now();
  const sessionId = `copilot-live-smoke-session-${now}`;
  const sessionKey = "agent:copilot-live-smoke:main";
  const storePath = join(params.copilotHome, "openclaw-agent.sqlite");
  const userMessage = { content: params.prompt, role: "user", timestamp: now } as const;
  await upsertSessionEntry({
    agentId: "copilot-live-smoke",
    entry: { sessionId, updatedAt: now },
    sessionKey,
    storePath,
  });

  return {
    agentDir: params.copilotHome,
    agentId: "copilot-live-smoke",
    ...(params.facts.kind === "github-copilot"
      ? { auth: params.facts.auth }
      : { resolvedApiKey: params.facts.resolvedApiKey }),
    authProfileId: params.facts.authProfileId,
    copilotHome: params.copilotHome,
    cwd: process.cwd(),
    hostCapabilities: createCopilotTestHostCapabilities(),
    messages: [userMessage],
    model: params.facts.model,
    modelId: params.facts.model.id,
    onAgentEvent: params.onAgentEvent,
    onAssistantDelta: params.onAssistantDelta,
    profileVersion,
    prompt: params.prompt,
    provider: params.facts.provider,
    runId: `copilot-live-smoke-${now}`,
    sessionFile: join(params.copilotHome, "copilot-live-smoke.session.json"),
    sessionId,
    sessionKey,
    sessionTarget: {
      agentId: "copilot-live-smoke",
      sessionId,
      sessionKey,
      storePath,
    },
    timeoutMs: 90_000,
    userTurnTranscriptRecorder: createLiveUserTurnRecorder(userMessage),
    workspaceDir: process.cwd(),
  } as unknown as AgentHarnessAttemptParams;
}

function createFinalizationAttempt(
  attempt: AgentHarnessAttemptParams,
  overrides: Partial<AgentHarnessAttemptParams>,
): SettledTurnFinalizationAttemptParams {
  const { hostCapabilities: _hostCapabilities, ...finalizationAttempt } = {
    ...attempt,
    ...overrides,
  };
  return finalizationAttempt;
}

describeLive("copilot agent runtime live smoke", () => {
  beforeAll(async () => {
    if (!AUTH_MODE) {
      throw new Error("Copilot live smoke requires a Copilot token or OPENAI_API_KEY");
    }
    const modelHome = await createTempDir("openclaw-copilot-live-model-");
    try {
      liveAttemptFacts = await resolveLiveAttemptFacts(AUTH_MODE, modelHome);
    } finally {
      await rm(modelHome, { recursive: true, force: true });
    }
  });

  it("uses one custom tool, then resumes with an isolated finalization turn", async () => {
    liveToolState.calls.length = 0;
    liveToolState.permissionRequests = 0;
    liveToolState.userInputRequests = 0;
    const streamedTexts: string[] = [];
    const finalEventTypes: string[] = [];
    const prompt = `Use the ${liveToolState.toolName} tool exactly once with text '${liveToolState.expectedText}', then reply with one short sentence.`;
    const copilotHome = await createTempDir("openclaw-copilot-live-");
    const facts = liveAttemptFacts;
    const modelId = facts.model.id;
    const harness = createCopilotAgentHarness({ pool: createLivePool() });

    try {
      expect(
        harness.supports({
          provider: facts.provider,
          modelId,
          ...(facts.kind === "openai-byok"
            ? {
                modelProvider: { api: facts.model.api, baseUrl: facts.model.baseUrl },
                providerOwnerPluginIds: [],
                providerOwnerStatus: "unowned" as const,
              }
            : {}),
          requestedRuntime: "copilot",
        }),
      ).toEqual({ supported: true, priority: 100 });

      const attempt = await createAttemptParams({
        copilotHome,
        facts,
        onAssistantDelta: ({ text }) => {
          if (text.trim()) {
            streamedTexts.push(text);
          }
        },
        prompt,
      });
      const settledResult = await harness.runAttempt(attempt);
      if (!("terminal" in settledResult)) {
        throw new Error("Copilot harness returned the deprecated attempt result shape");
      }
      const matchingCalls = liveToolState.calls.filter(
        (text) => text === liveToolState.expectedText,
      );
      expect(settledResult.terminal).toEqual({ kind: "ok" });
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
        attempt: createFinalizationAttempt(attempt, {
          onAgentEvent: (event: unknown) => {
            const type = (event as { type?: unknown } | undefined)?.type;
            if (typeof type === "string") {
              finalEventTypes.push(type);
            }
          },
          prompt: finalPrompt,
          runId: `${attempt.runId}-finalize`,
        }),
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

  it("delegates user-followed deliverable work through a visible OpenClaw session", async () => {
    liveToolState.spawnCalls.length = 0;
    const streamedTexts: string[] = [];
    const copilotHome = await createTempDir("openclaw-copilot-live-delegation-");
    const facts = liveAttemptFacts;
    const modelId = facts.model.id;
    const harness = createCopilotAgentHarness({ pool: createLivePool() });

    try {
      const prompt =
        "Investigate how prompt-hook tool narrowing is implemented in this codebase. Delegate exactly one user-followed codebase investigation that produces its own report, then reply with the returned report link.";
      const result = await harness.runAttempt(
        await createAttemptParams({
          copilotHome,
          facts,
          onAssistantDelta: ({ text }) => {
            if (text.trim()) {
              streamedTexts.push(text);
            }
          },
          prompt,
        }),
      );
      if (!("terminal" in result)) {
        throw new Error("Copilot harness returned the deprecated attempt result shape");
      }

      const assistantText = result.assistantTexts.join("\n");
      console.info(
        "[copilot-live-delegation] summary",
        JSON.stringify(
          { assistantText, modelId, spawnCalls: liveToolState.spawnCalls, streamedTexts },
          null,
          2,
        ),
      );
      expect(result.terminal).toEqual({ kind: "ok" });
      expect(liveToolState.spawnCalls).toHaveLength(1);
      expect(liveToolState.spawnCalls[0]?.visible).toBe(true);
      expect(liveToolState.spawnCalls[0]?.task).not.toBe("");
      expect(assistantText).toContain("https://example.test/session/live-proof");
    } finally {
      await harness.dispose?.();
      await rm(copilotHome, { recursive: true, force: true });
    }
  }, 180_000);
});
