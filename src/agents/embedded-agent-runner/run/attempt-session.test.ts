import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../sessions/index.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

const hoisted = vi.hoisted(() => ({
  applyAgentAutoCompactionGuard: vi.fn(),
  applyAgentCompactionSettingsFromConfig: vi.fn(),
  applySystemPromptToSession: vi.fn(),
  buildEmbeddedExtensionFactories: vi.fn(),
  createAgentSessionForEmbeddedRunner: vi.fn(),
  createEmbeddedAgentResourceLoader: vi.fn(),
  createPreparedEmbeddedAgentSettingsManager: vi.fn(),
  getGlobalHookRunner: vi.fn(),
  installMessageToolOnlyTerminalHook: vi.fn(),
  prepareEmbeddedAttemptClientTools: vi.fn(),
  resolveCompactionEnabled: vi.fn(() => true),
  resolveEffectiveCompactionMode: vi.fn(),
  isSilentOverflowProneModel: vi.fn(),
  resolveToolSearchCatalogTool: vi.fn(),
  toToolDefinitions: vi.fn(),
  wrapToolDefinition: vi.fn(),
  notifyToolActivity: vi.fn(),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hoisted.getGlobalHookRunner,
}));
vi.mock("../../agent-project-settings.js", () => ({
  createPreparedEmbeddedAgentSettingsManager: hoisted.createPreparedEmbeddedAgentSettingsManager,
}));
vi.mock("../../agent-settings.js", () => ({
  applyAgentAutoCompactionGuard: hoisted.applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig: hoisted.applyAgentCompactionSettingsFromConfig,
  isSilentOverflowProneModel: hoisted.isSilentOverflowProneModel,
  resolveCompactionEnabled: hoisted.resolveCompactionEnabled,
  resolveEffectiveCompactionMode: hoisted.resolveEffectiveCompactionMode,
}));
vi.mock("../../agent-tool-definition-adapter.js", () => ({
  toToolDefinitions: hoisted.toToolDefinitions,
}));
vi.mock("../../sessions/sdk.js", () => ({
  createAgentSessionForEmbeddedRunner: hoisted.createAgentSessionForEmbeddedRunner,
}));
vi.mock("../../sessions/tools/tool-definition-wrapper.js", () => ({
  wrapToolDefinition: hoisted.wrapToolDefinition,
}));
vi.mock("../../tool-search.js", () => ({
  resolveToolSearchCatalogTool: hoisted.resolveToolSearchCatalogTool,
}));
vi.mock("../extensions.js", () => ({
  buildEmbeddedExtensionFactories: hoisted.buildEmbeddedExtensionFactories,
}));
vi.mock("../logger.js", () => ({ log: { info: vi.fn() } }));
vi.mock("../resource-loader.js", () => ({
  createEmbeddedAgentResourceLoader: hoisted.createEmbeddedAgentResourceLoader,
}));
vi.mock("../system-prompt.js", () => ({
  applySystemPromptToSession: hoisted.applySystemPromptToSession,
}));
vi.mock("./attempt-client-tools.js", () => ({
  prepareEmbeddedAttemptClientTools: hoisted.prepareEmbeddedAttemptClientTools,
}));
vi.mock("./message-tool-terminal.js", () => ({
  installMessageToolOnlyTerminalHook: hoisted.installMessageToolOnlyTerminalHook,
}));
vi.mock("./tool-activity-heartbeat.js", () => ({
  notifyToolActivity: hoisted.notifyToolActivity,
}));

import { prepareEmbeddedAttemptAgentSession } from "./attempt-session.js";

const attempt = {
  authStorage: { id: "auth" },
  config: {},
  contextTokenBudget: 32_000,
  model: { id: "model-1", api: "anthropic-messages" },
  modelId: "model-1",
  modelRegistry: { id: "registry" },
  provider: "anthropic",
  prompt: "prompt",
  runId: "run-1",
  sessionId: "session-1",
  sourceReplyDeliveryMode: "message_tool_only",
  timeoutMs: 30_000,
  workspaceDir: "/workspace",
} as unknown as EmbeddedRunAttemptParams;

function createInput(options?: { activationError?: Error }) {
  const events: string[] = [];
  const settingsManager = { id: "settings" };
  const resourceLoader = {
    reload: vi.fn(async () => {
      events.push("resource-reload");
    }),
  };
  const setActiveToolsByName = vi.fn(() => {
    events.push("activate-tools");
    if (options?.activationError) {
      throw options.activationError;
    }
  });
  const activeSession = {
    agent: { id: "agent" },
    setActiveToolsByName,
  } as unknown as AgentSession;
  const sessionManager = { id: "session-manager" };
  const sessionLockController = {
    withSessionWriteLock: vi.fn(async (operation: () => unknown) => await operation()),
  };
  const hookRunner = { id: "hooks" };
  const sessionToolAllowlist = [{ name: "read" }];
  const allCustomTools = [{ name: "custom" }];
  const clientToolRuntime = {
    builtinToolNames: new Set(["read"]),
    clientToolCallSlots: [],
    clientToolDefs: [],
    clientToolLoopDetection: { enabled: true },
    replaySafeToolNames: new Set(["read"]),
    replaySafeTools: new Set(allCustomTools),
  };
  let onDeliveredSourceReply: (() => void) | undefined;

  hoisted.createPreparedEmbeddedAgentSettingsManager.mockReturnValue(settingsManager);
  hoisted.resolveEffectiveCompactionMode.mockReturnValue("safeguard");
  hoisted.isSilentOverflowProneModel.mockReturnValue(false);
  hoisted.buildEmbeddedExtensionFactories.mockReturnValue([{ id: "extension" }]);
  hoisted.createEmbeddedAgentResourceLoader.mockReturnValue(resourceLoader);
  hoisted.getGlobalHookRunner.mockReturnValue(hookRunner);
  hoisted.prepareEmbeddedAttemptClientTools.mockReturnValue({
    allCustomTools,
    sessionToolAllowlist,
    ...clientToolRuntime,
  });
  hoisted.createAgentSessionForEmbeddedRunner.mockImplementation(async () => {
    events.push("create-session");
    return { session: activeSession };
  });
  hoisted.applySystemPromptToSession.mockImplementation(() => {
    events.push("apply-system-prompt");
  });
  hoisted.installMessageToolOnlyTerminalHook.mockImplementation(
    (input: { onDeliveredSourceReply?: () => void }) => {
      events.push("install-terminal-hook");
      onDeliveredSourceReply = input.onDeliveredSourceReply;
    },
  );

  return {
    activeSession,
    allCustomTools,
    clientToolRuntime,
    events,
    hookRunner,
    input: {
      attempt,
      agentCoreThinkingLevel: "high" as const,
      agentDir: "/agent",
      clientToolPreparation: { deferredDirectoryToolsCallable: false } as never,
      effectiveCwd: "/workspace",
      getCurrentAttemptPluginMetadataSnapshot: () => undefined,
      initialSystemPrompt: "system prompt",
      markStage: (stage: string) => events.push(`stage:${stage}`),
      onSessionCreated: (session: AgentSession) => {
        expect(session).toBe(activeSession);
        events.push("publish-session");
      },
      onSystemPromptChanged: (systemPrompt: string) => {
        expect(systemPrompt).toBe("system prompt");
        events.push("publish-system-prompt");
      },
      runAbortSignal: new AbortController().signal,
      sessionAgentId: "agent-1",
      sessionLockController: sessionLockController as never,
      sessionManager: sessionManager as never,
    },
    onDeliveredSourceReply: () => onDeliveredSourceReply?.(),
    resourceLoader,
    setActiveToolsByName,
    sessionToolAllowlist,
    settingsManager,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prepareEmbeddedAttemptAgentSession", () => {
  it("prepares resources and publishes the activated session runtime", async () => {
    const fixture = createInput();

    const result = await prepareEmbeddedAttemptAgentSession(fixture.input);

    expect(fixture.events).toEqual([
      "resource-reload",
      "stage:session-resource-loader",
      "create-session",
      "publish-session",
      "activate-tools",
      "publish-system-prompt",
      "apply-system-prompt",
      "install-terminal-hook",
      "stage:agent-session",
    ]);
    expect(hoisted.applyAgentAutoCompactionGuard).toHaveBeenCalledTimes(2);
    expect(hoisted.applyAgentCompactionSettingsFromConfig).toHaveBeenCalledOnce();
    expect(hoisted.createAgentSessionForEmbeddedRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceLoader: fixture.resourceLoader,
      }),
      { contextOverflowRecoveryOwner: "caller" },
    );
    expect(hoisted.createAgentSessionForEmbeddedRunner.mock.calls[0]?.[0]).not.toHaveProperty(
      "contextOverflowRecoveryOwner",
    );
    expect(fixture.setActiveToolsByName).toHaveBeenCalledWith(fixture.sessionToolAllowlist);
    expect(result).toEqual(
      expect.objectContaining({
        activeSession: fixture.activeSession,
        allCustomTools: fixture.allCustomTools,
        hookRunner: fixture.hookRunner,
        settingsManager: fixture.settingsManager,
        ...fixture.clientToolRuntime,
      }),
    );
    expect(result.hasDeliveredSourceReply()).toBe(false);
    fixture.onDeliveredSourceReply();
    expect(result.hasDeliveredSourceReply()).toBe(true);
  });

  it("leaves overflow recovery with the session when no model budget was resolved", async () => {
    const fixture = createInput();
    fixture.input.attempt = {
      ...fixture.input.attempt,
      contextTokenBudget: undefined,
    };

    await prepareEmbeddedAttemptAgentSession(fixture.input);

    expect(hoisted.createAgentSessionForEmbeddedRunner).toHaveBeenCalledWith(expect.any(Object), {
      contextOverflowRecoveryOwner: "session",
    });
  });

  it("publishes session ownership before activation can fail", async () => {
    const fixture = createInput({ activationError: new Error("activation failed") });

    await expect(prepareEmbeddedAttemptAgentSession(fixture.input)).rejects.toThrow(
      "activation failed",
    );

    expect(fixture.events).toEqual([
      "resource-reload",
      "stage:session-resource-loader",
      "create-session",
      "publish-session",
      "activate-tools",
    ]);
  });
});
