// Live end-to-end checks for AgentSession turns, compaction, and follow-up delivery.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { getRuntimeConfig } from "../../config/config.js";
import { discoverModels } from "../agent-model-discovery.js";
import { isLiveTestEnabled } from "../live-test-helpers.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import type { AgentMessage } from "../runtime/index.js";
import { AgentSession } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { LoadExtensionsResult, ToolDefinition } from "./extensions/types.js";
import type { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { createSyntheticSourceInfo } from "./source-info.js";

const API_KEY = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
const LIVE = isLiveTestEnabled() && API_KEY.length > 0;
const describeLive = LIVE ? describe : describe.skip;
const TEST_TIMEOUT_MS = 120_000;
const PROVIDER_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL_ID = "claude-haiku-4-5";

const sessions: AgentSession[] = [];
const tempRoots: string[] = [];

type ExtensionHandlers = Map<string, Array<(...args: unknown[]) => Promise<unknown>>>;

function createResourceLoader(handlers: ExtensionHandlers = new Map()): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions:
      handlers.size > 0
        ? [
            {
              path: "<live-test-extension>",
              resolvedPath: "<live-test-extension>",
              sourceInfo: createSyntheticSourceInfo("<live-test-extension>", {
                source: "temporary",
              }),
              handlers,
              tools: new Map(),
              messageRenderers: new Map(),
              commands: new Map(),
              flags: new Map(),
              shortcuts: new Map(),
            },
          ]
        : [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function resolveLiveModel(
  agentDir: string,
  authStorage: AuthStorage,
): Promise<{ model: Model; modelRegistry: ModelRegistry }> {
  await ensureOpenClawModelsJson(getRuntimeConfig(), agentDir, {
    providerDiscoveryProviderIds: ["anthropic"],
  });
  const modelRegistry = discoverModels(authStorage, agentDir, { providerFilter: "anthropic" });
  const requestedModelId =
    process.env.OPENCLAW_LIVE_AGENT_SESSION_MODEL?.trim() || DEFAULT_MODEL_ID;
  const model =
    modelRegistry.find("anthropic", requestedModelId) ??
    modelRegistry
      .getAll()
      .find((candidate) => candidate.provider === "anthropic" && /haiku/i.test(candidate.id));
  if (!model) {
    throw new Error(`No Anthropic Haiku model found for ${requestedModelId}`);
  }
  return {
    model: { ...model, maxTokens: Math.min(model.maxTokens, 128) },
    modelRegistry,
  };
}

async function createLiveSession(
  options: {
    customTools?: ToolDefinition[];
    handlers?: ExtensionHandlers;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "openclaw-agent-session-live-"));
  tempRoots.push(root);
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey("anthropic", API_KEY);
  const { model, modelRegistry } = await resolveLiveModel(agentDir, authStorage);
  const sessionManager = SessionManager.inMemory();
  const settingsManager = SettingsManager.inMemory({
    defaultThinkingLevel: "off",
    compaction: { enabled: true, reserveTokens: 128, keepRecentTokens: 0 },
    retry: {
      enabled: false,
      provider: { timeoutMs: PROVIDER_TIMEOUT_MS, maxRetries: 0, maxRetryDelayMs: 0 },
    },
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: "off",
    noTools: "builtin",
    customTools: options.customTools,
    resourceLoader: createResourceLoader(options.handlers),
    authStorage,
    modelRegistry,
    sessionManager,
    settingsManager,
  });
  sessions.push(session);
  return { session, sessionManager };
}

function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant") {
    return "";
  }
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.dispose();
  }
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describeLive("AgentSession live", () => {
  it(
    "completes a real tool turn",
    async () => {
      let toolExecutions = 0;
      const echoParameters = Type.Object({ text: Type.String() });
      const echoTool: ToolDefinition<typeof echoParameters> = {
        name: "live_echo",
        label: "Live echo",
        description:
          "Return the supplied text unchanged. Use when the user explicitly requests it.",
        parameters: echoParameters,
        execute: async (_toolCallId, params) => {
          toolExecutions += 1;
          return {
            content: [{ type: "text", text: params.text }],
            details: {},
          };
        },
      };
      const { session } = await createLiveSession({ customTools: [echoTool] });

      await session.prompt(
        "Call live_echo exactly once with text OK. After its result, reply with exactly OK.",
      );

      const finalAssistant = session.messages.findLast(
        (message) => message.role === "assistant" && message.stopReason === "stop",
      );
      expect(toolExecutions).toBe(1);
      expect(finalAssistant).toBeDefined();
      if (finalAssistant?.role !== "assistant") {
        throw new Error("missing final assistant message");
      }
      expect(finalAssistant.usage.output).toBeGreaterThan(0);
      expect(assistantText(finalAssistant)).not.toBe("");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "manually compacts a completed turn and remains usable",
    async () => {
      const { session, sessionManager } = await createLiveSession();
      await session.prompt("Reply with exactly OK.");

      const result = await session.compact();
      const compaction = sessionManager
        .getBranch()
        .findLast((entry) => entry.type === "compaction");

      expect(result.summary.trim().length).toBeGreaterThan(0);
      expect(compaction?.type).toBe("compaction");
      if (compaction?.type !== "compaction") {
        throw new Error("missing compaction entry");
      }
      expect(compaction.summary.trim().length).toBeGreaterThan(0);

      await session.prompt("Reply with exactly STILL_OK.");
      expect((session.getLastAssistantText() ?? "").trim().length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "drains a follow-up queued by an agent-end handler",
    async () => {
      const sessionRef: { current?: AgentSession } = {};
      let queued = false;
      const handlers: ExtensionHandlers = new Map([
        [
          "agent_end",
          [
            async () => {
              if (!queued) {
                queued = true;
                await sessionRef.current?.followUp("Reply with exactly SECOND.");
              }
              return undefined;
            },
          ],
        ],
      ]);
      const { session } = await createLiveSession({ handlers });
      sessionRef.current = session;

      await session.prompt("Reply with exactly FIRST.");

      const assistants = session.messages.filter(
        (message) => message.role === "assistant" && message.stopReason === "stop",
      );
      const deliveredFollowUp = session.messages.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) => block.type === "text" && block.text === "Reply with exactly SECOND.",
          ),
      );
      expect(deliveredFollowUp).toBe(true);
      expect(assistants).toHaveLength(2);
      expect(assistants.every((message) => assistantText(message).length > 0)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
