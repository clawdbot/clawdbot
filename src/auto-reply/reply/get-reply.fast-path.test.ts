// Tests get-reply fast-path command handling before full agent dispatch.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getSessionEntry } from "../../config/sessions.js";
import {
  readSessionStoreForTest,
  writeSessionStoreForTestAsync,
} from "../../config/sessions/test-helpers.js";
import {
  MODEL_SELECTION_LOCKED_RESET_MESSAGE,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { handleGoalCommand } from "./commands-goal.js";
import {
  buildFastReplyCommandContext,
  initFastReplySessionState,
  markCompleteReplyConfig,
  withFastReplyConfig,
} from "./get-reply-fast-path.js";
import {
  buildGetReplyCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  expectResolvedTelegramTimezone,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

type LoadModelCatalogFn = typeof import("../../agents/model-catalog.js").loadModelCatalog;
type ModelAliasIndex = import("../../agents/model-selection.js").ModelAliasIndex;

function emptyAliasIndex(): ModelAliasIndex {
  return { byAlias: new Map(), byKey: new Map() };
}

const mocks = vi.hoisted(() => ({
  buildStatusReply: vi.fn(),
  ensureAgentWorkspace: vi.fn(),
  handleCommands: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  loadModelCatalog: vi.fn<LoadModelCatalogFn>(async () => [
    {
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      reasoning: true,
    },
  ]),
  resolveReplyDirectives: vi.fn(),
}));

vi.mock("./commands.runtime.js", () => ({
  handleCommands: (...args: unknown[]) => mocks.handleCommands(...args),
}));

vi.mock("./commands-status.js", () => ({
  buildStatusReply: (...args: unknown[]) => mocks.buildStatusReply(...args),
}));

vi.mock("../../agents/model-catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-catalog.js")>(
    "../../agents/model-catalog.js",
  );
  return {
    ...actual,
    loadModelCatalog: mocks.loadModelCatalog,
  };
});

vi.mock("../../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/openclaw-workspace",
  ensureAgentWorkspace: (...args: unknown[]) => mocks.ensureAgentWorkspace(...args),
}));
registerGetReplyRuntimeOverrides(mocks);

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let resolveDefaultModelMock: typeof import("./directive-handling.defaults.js").resolveDefaultModel;
let resolveModelRefFromStringMock: typeof import("../../agents/model-selection.js").resolveModelRefFromString;
let loadConfigMock: typeof import("../../config/config.js").getRuntimeConfig;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ resolveDefaultModel: resolveDefaultModelMock } =
    await import("./directive-handling.defaults.js"));
  ({ resolveModelRefFromString: resolveModelRefFromStringMock } =
    await import("../../agents/model-selection.js"));
  ({ getRuntimeConfig: loadConfigMock } = await import("../../config/config.js"));
  ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
}

function requirePreparedReplyParams() {
  const preparedReplyParams = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
  if (!preparedReplyParams) {
    throw new Error("expected prepared reply params");
  }
  return preparedReplyParams;
}

function requireDirectiveParams() {
  const directiveParams = mocks.resolveReplyDirectives.mock.calls[0]?.[0] as
    | {
        sessionKey?: string;
        workspaceDir?: string;
        provider?: string;
        model?: string;
      }
    | undefined;
  if (!directiveParams) {
    throw new Error("expected directive params");
  }
  return directiveParams;
}

async function seedFastPathSessionStore(
  storePath: string,
  entries: Record<string, Record<string, unknown>>,
): Promise<void> {
  await writeSessionStoreForTestAsync(storePath, entries);
}

function readFastPathSessionEntry(storePath: string, sessionKey: string): Record<string, unknown> {
  return readSessionStoreForTest<Record<string, unknown>>(storePath)[sessionKey] ?? {};
}

describe("getReplyFromConfig fast test bootstrap", () => {
  beforeAll(async () => {
    await loadGetReplyRuntimeForTest();
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [],
    });
    mocks.buildStatusReply.mockReset();
    mocks.buildStatusReply.mockImplementation(async (params: unknown) => {
      const status = params as {
        cfg: OpenClawConfig;
        resolvedThinkLevel?: string;
        resolveDefaultThinkingLevel: () => Promise<string | undefined>;
        sessionKey?: string;
      };
      const agentId = status.sessionKey?.split(":")[1];
      const agentThinkingDefault = status.cfg.agents?.list?.find(
        (agent) => agent.id === agentId,
      )?.thinkingDefault;
      const thinkLevel =
        status.resolvedThinkLevel ??
        agentThinkingDefault ??
        status.cfg.agents?.defaults?.thinkingDefault ??
        (await status.resolveDefaultThinkingLevel());
      return { text: `OpenClaw\nThink: ${thinkLevel ?? "off"}` };
    });
    mocks.ensureAgentWorkspace.mockReset();
    mocks.handleCommands.mockReset();
    mocks.handleCommands.mockImplementation(async (params: unknown) => {
      const result = await handleGoalCommand(
        params as Parameters<typeof handleGoalCommand>[0],
        true,
      );
      return result ?? { shouldContinue: true, reply: undefined };
    });
    mocks.handleInlineActions.mockReset();
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    mocks.initSessionState.mockReset();
    mocks.loadModelCatalog.mockReset();
    mocks.loadModelCatalog.mockResolvedValue([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        reasoning: true,
      },
    ]);
    mocks.resolveReplyDirectives.mockReset();
    vi.mocked(resolveDefaultModelMock).mockReset();
    vi.mocked(resolveDefaultModelMock).mockReturnValue({
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex: emptyAliasIndex(),
    });
    vi.mocked(resolveModelRefFromStringMock).mockReset();
    vi.mocked(resolveModelRefFromStringMock).mockReturnValue(null);
    vi.mocked(loadConfigMock).mockReset();
    vi.mocked(runPreparedReplyMock).mockReset();
    vi.mocked(loadConfigMock).mockReturnValue({});
    mocks.resolveReplyDirectives.mockResolvedValue({ kind: "reply", reply: { text: "ok" } });
    vi.mocked(runPreparedReplyMock).mockResolvedValue({ text: "ok" });
    mocks.initSessionState.mockResolvedValue(createGetReplySessionState());
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    vi.unstubAllEnvs();
  });

  it("fails fast on unmarked config overrides in strict fast-test mode", async () => {
    await expect(
      getReplyFromConfig(buildGetReplyCtx(), undefined, {} as OpenClawConfig),
    ).rejects.toThrow(/withFastReplyConfig\(\)\/markCompleteReplyConfig\(\)/);
    expect(vi.mocked(loadConfigMock)).not.toHaveBeenCalled();
  });

  it("skips getRuntimeConfig, workspace bootstrap, and session bootstrap for marked test configs", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-reply-"));
    const cfg = markCompleteReplyConfig({
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-6",
          workspace: path.join(home, "openclaw"),
        },
      },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: path.join(home, "sessions.json") },
    } as OpenClawConfig);

    await expect(getReplyFromConfig(buildGetReplyCtx(), undefined, cfg)).resolves.toEqual({
      text: "ok",
    });
    expect(vi.mocked(loadConfigMock)).not.toHaveBeenCalled();
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const preparedReplyParams = requirePreparedReplyParams();
    expect(preparedReplyParams.cfg).toBe(cfg);
  });

  it("still merges partial config overrides against getRuntimeConfig()", async () => {
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    vi.mocked(loadConfigMock).mockReturnValue({
      channels: {
        telegram: {
          botToken: "resolved-telegram-token",
        },
      },
    } satisfies OpenClawConfig);

    await getReplyFromConfig(buildGetReplyCtx(), undefined, {
      agents: {
        defaults: {
          userTimezone: "America/New_York",
        },
      },
    } as OpenClawConfig);

    expect(vi.mocked(loadConfigMock)).toHaveBeenCalledOnce();
    expect(mocks.initSessionState).toHaveBeenCalledOnce();
    expectResolvedTelegramTimezone(mocks.resolveReplyDirectives);
  });

  it("reports the prepared session binding after session bootstrap", async () => {
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionKey: "agent:main:slack:channel:C123",
        sessionId: "rotated-session",
        storePath: "/tmp/custom-sessions.json",
      }),
    );
    const onSessionPrepared = vi.fn();

    await getReplyFromConfig(
      buildGetReplyCtx({
        Provider: "slack",
        Surface: "slack",
        SessionKey: "agent:main:slack:channel:C123",
      }),
      { onSessionPrepared } as never,
      {} as OpenClawConfig,
    );

    expect(onSessionPrepared).toHaveBeenCalledWith({
      sessionKey: "agent:main:slack:channel:C123",
      sessionId: "rotated-session",
      storePath: "/tmp/custom-sessions.json",
    });
  });

  it("returns a clean rejection when session bootstrap rejects a locked reset", async () => {
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    const sessionKey = "agent:main:telegram:123";
    mocks.initSessionState.mockRejectedValueOnce(
      new ModelSelectionLockedError(MODEL_SELECTION_LOCKED_RESET_MESSAGE),
    );

    const result = await getReplyFromConfig(
      buildGetReplyCtx({
        Body: "/reset openai/gpt-5.5 continue",
        RawBody: "/reset openai/gpt-5.5 continue",
        CommandBody: "/reset openai/gpt-5.5 continue",
        CommandAuthorized: true,
        SessionKey: sessionKey,
      }),
      undefined,
      {} as OpenClawConfig,
    );

    expect(result).toEqual({ text: MODEL_SELECTION_LOCKED_RESET_MESSAGE });
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).not.toHaveBeenCalled();
  });

  it("marks configs through withFastReplyConfig()", async () => {
    const cfg = withFastReplyConfig({ session: { store: "/tmp/sessions.json" } } as OpenClawConfig);

    await expect(getReplyFromConfig(buildGetReplyCtx(), undefined, cfg)).resolves.toEqual({
      text: "ok",
    });
    expect(vi.mocked(loadConfigMock)).not.toHaveBeenCalled();
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
  });

  it("clears stale ack-only heartbeat pending delivery before running heartbeat", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-pending-clear-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "pending-ack",
        updatedAt: Date.now(),
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "HEARTBEAT_OK",
        pendingFinalDeliveryCreatedAt: 1,
        pendingFinalDeliveryAttemptCount: 4,
        pendingFinalDeliveryLastError: null,
      },
    });
    const cfg = withFastReplyConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          workspace: home,
          heartbeat: { ackMaxChars: 300 },
        },
      },
      session: { store: storePath },
    } as OpenClawConfig);

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), { isHeartbeat: true }, cfg),
    ).resolves.toEqual({ text: "ok" });

    const stored = readFastPathSessionEntry(storePath, sessionKey);
    expect(stored.pendingFinalDelivery).toBeUndefined();
    expect(stored.pendingFinalDeliveryText).toBeUndefined();
    expect(stored.pendingFinalDeliveryAttemptCount).toBeUndefined();
  });

  it("keeps non-ack heartbeat pending delivery without direct replay", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-pending-replay-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "pending-ack-with-remainder",
        updatedAt: Date.now(),
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "HEARTBEAT_OK short",
      },
    });
    const cfg = withFastReplyConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          workspace: home,
          heartbeat: { ackMaxChars: 0 },
        },
      },
      session: { store: storePath },
    } as OpenClawConfig);

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), { isHeartbeat: true }, cfg),
    ).resolves.toEqual({ text: "ok" });

    const stored = readFastPathSessionEntry(storePath, sessionKey);
    expect(stored.pendingFinalDelivery).toBe(true);
    expect(stored.pendingFinalDeliveryText).toBe("HEARTBEAT_OK short");
    expect(stored.pendingFinalDeliveryAttemptCount).toBeUndefined();
  });

  it("does not replay stale heartbeat pending delivery", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-pending-suppress-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "pending-user-final",
        updatedAt: Date.now() - 60_000,
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "private prior user answer",
        pendingFinalDeliveryCreatedAt: 1,
      },
    });
    const cfg = withFastReplyConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          workspace: home,
          heartbeat: { ackMaxChars: 300 },
        },
      },
      session: { store: storePath },
    } as OpenClawConfig);

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), { isHeartbeat: true }, cfg),
    ).resolves.toEqual({
      text: "ok",
    });

    const stored = readFastPathSessionEntry(storePath, sessionKey);
    expect(stored.pendingFinalDelivery).toBe(true);
    expect(stored.pendingFinalDeliveryText).toBe("private prior user answer");
    expect(stored.pendingFinalDeliveryAttemptCount).toBeUndefined();
  });

  it("handles native /status before workspace bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-status-fast-"));
    const targetSessionKey = "agent:main:telegram:123";
    const cfg = markCompleteReplyConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          workspace: path.join(home, "workspace"),
        },
      },
      session: { store: path.join(home, "sessions.json") },
    } as OpenClawConfig);
    vi.mocked(resolveDefaultModelMock).mockReturnValueOnce({
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: emptyAliasIndex(),
    });

    const reply = await getReplyFromConfig(
      buildGetReplyCtx({
        Body: "/status",
        BodyForAgent: "/status",
        RawBody: "/status",
        CommandBody: "/status",
        CommandSource: "native",
        CommandAuthorized: true,
        SessionKey: "telegram:slash:123",
        CommandTargetSessionKey: targetSessionKey,
      }),
      undefined,
      cfg,
    );

    if (!reply || Array.isArray(reply) || typeof reply.text !== "string") {
      throw new Error("expected status reply text");
    }
    expect(reply.text.includes("OpenClaw")).toBe(true);
    expect(reply.text.includes("Think: medium")).toBe(true);
    expect(mocks.loadModelCatalog).toHaveBeenCalledWith({ config: cfg });
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).not.toHaveBeenCalled();
  });

  it("uses configured agent thinking defaults for native /status", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-status-agent-think-"));
    const targetSessionKey = "agent:main:telegram:123";
    const cfg = markCompleteReplyConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          workspace: path.join(home, "workspace"),
          thinkingDefault: "low",
        },
        list: [
          {
            id: "main",
            thinkingDefault: "high",
          },
        ],
      },
      session: { store: path.join(home, "sessions.json") },
    } as OpenClawConfig);
    vi.mocked(resolveDefaultModelMock).mockReturnValueOnce({
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: emptyAliasIndex(),
    });

    const reply = await getReplyFromConfig(
      buildGetReplyCtx({
        Body: "/status",
        BodyForAgent: "/status",
        RawBody: "/status",
        CommandBody: "/status",
        CommandSource: "native",
        CommandAuthorized: true,
        SessionKey: "telegram:slash:123",
        CommandTargetSessionKey: targetSessionKey,
      }),
      undefined,
      cfg,
    );

    expect(Array.isArray(reply)).toBe(false);
    if (!reply || Array.isArray(reply)) {
      throw new Error("expected single reply payload");
    }
    expect(reply.text).toContain("Think: high");
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).not.toHaveBeenCalled();
  });

  it("uses the target session thinking override for native /status", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-status-think-"));
    const storePath = path.join(home, "sessions.json");
    const targetSessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [targetSessionKey]: {
        sessionId: "existing-telegram-session",
        thinkingLevel: "xhigh",
        updatedAt: 1,
      },
    });
    const cfg = markCompleteReplyConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          workspace: path.join(home, "workspace"),
        },
      },
      session: { store: storePath },
    } as OpenClawConfig);
    vi.mocked(resolveDefaultModelMock).mockReturnValueOnce({
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: emptyAliasIndex(),
    });

    const reply = await getReplyFromConfig(
      buildGetReplyCtx({
        Body: "/status",
        BodyForAgent: "/status",
        RawBody: "/status",
        CommandBody: "/status",
        CommandSource: "native",
        CommandAuthorized: true,
        SessionKey: "telegram:slash:123",
        CommandTargetSessionKey: targetSessionKey,
      }),
      undefined,
      cfg,
    );

    expect(Array.isArray(reply)).toBe(false);
    if (!reply || Array.isArray(reply)) {
      throw new Error("expected single reply payload");
    }
    expect(reply.text).toContain("Think: xhigh");
    expect(getReplyPayloadMetadata(reply)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).not.toHaveBeenCalled();
  });

  it("handles native slash directives before workspace bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-slash-fast-"));
    const targetSessionKey = "agent:main:telegram:123";
    const cfg = markCompleteReplyConfig({
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-6",
          workspace: path.join(home, "workspace"),
        },
      },
      session: { store: path.join(home, "sessions.json") },
    } as OpenClawConfig);
    mocks.resolveReplyDirectives.mockResolvedValueOnce({
      kind: "reply",
      reply: { text: "model status" },
    });

    const reply = await getReplyFromConfig(
      buildGetReplyCtx({
        Body: "/model status",
        BodyForAgent: "/model status",
        RawBody: "/model status",
        CommandBody: "/model status",
        CommandSource: "native",
        CommandAuthorized: true,
        SessionKey: "telegram:slash:123",
        CommandTargetSessionKey: targetSessionKey,
      }),
      undefined,
      cfg,
    );

    expect(reply).toMatchObject({ text: "model status" });
    if (!reply || Array.isArray(reply)) {
      throw new Error("expected single reply payload");
    }
    expect(getReplyPayloadMetadata(reply)?.deliverDespiteSourceReplySuppression).toBe(true);

    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).not.toHaveBeenCalled();
    expect(mocks.handleCommands).toHaveBeenCalledOnce();
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledOnce();
    const directiveParams = requireDirectiveParams();
    expect(directiveParams.sessionKey).toBe(targetSessionKey);
    expect(directiveParams.workspaceDir).toBe("/tmp/workspace");
  });

  it("continues native slash goal starts with the rewritten command-safe prompt", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-goal-fast-"));
    const targetSessionKey = "agent:main:telegram:123";
    const storePath = path.join(home, "sessions.json");
    const cfg = markCompleteReplyConfig({
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-6",
          workspace: path.join(home, "workspace"),
        },
      },
      session: { store: storePath },
    } as OpenClawConfig);
    const continuationPrompt = `Pursue this goal exactly as written from this JSON string: "\\/status"`;
    const continueDirectives = async (params: unknown) =>
      createGetReplyContinueDirectivesResult({
        body: (params as { triggerBodyNormalized: string }).triggerBodyNormalized,
        abortKey: targetSessionKey,
        from: "telegram:user:42",
        to: "telegram:123",
        senderId: "telegram:user:42",
        commandSource: (params as { triggerBodyNormalized: string }).triggerBodyNormalized,
        senderIsOwner: true,
        resetHookTriggered: false,
      });
    mocks.resolveReplyDirectives
      .mockImplementationOnce(continueDirectives)
      .mockImplementationOnce(async (params: unknown) => {
        expect((params as { triggerBodyNormalized: string }).triggerBodyNormalized).toBe(
          continuationPrompt,
        );
        return continueDirectives(params);
      });
    mocks.handleInlineActions.mockImplementation(async (params: unknown) => {
      expect(params).toMatchObject({
        command: {
          rawBodyNormalized: continuationPrompt,
          commandBodyNormalized: continuationPrompt,
        },
        cleanedBody: continuationPrompt,
      });
      return {
        kind: "continue",
        directives: {},
        abortedLastRun: false,
        cleanedBody: continuationPrompt,
      };
    });
    const onSessionMetadataChanges = vi.fn();

    await expect(
      getReplyFromConfig(
        buildGetReplyCtx({
          Body: "/goal start /status",
          BodyForAgent: "/goal start /status",
          RawBody: "/goal start /status",
          CommandBody: "/goal start /status",
          CommandSource: "native",
          CommandAuthorized: true,
          SessionKey: "telegram:slash:123",
          CommandTargetSessionKey: targetSessionKey,
        }),
        { onSessionMetadataChanges } as never,
        cfg,
      ),
    ).resolves.toEqual({ text: "ok" });

    expect(onSessionMetadataChanges).toHaveBeenCalledWith([
      { sessionKey: targetSessionKey, agentId: "main", reason: "command-metadata" },
    ]);
    expect(onSessionMetadataChanges.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runPreparedReplyMock).mock.invocationCallOrder[0],
    );
    expect(getSessionEntry({ storePath, sessionKey: targetSessionKey })?.goal?.objective).toBe(
      "/status",
    );
    const preparedReplyParams = requirePreparedReplyParams();
    expect(preparedReplyParams.command.commandBodyNormalized).toBe(continuationPrompt);
    expect(preparedReplyParams.sessionCtx.BodyForAgent).toBe(continuationPrompt);
    expect(mocks.handleInlineActions).toHaveBeenCalledTimes(2);
  });

  it("uses native command target session keys during fast bootstrap", () => {
    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        SessionKey: "telegram:slash:123",
        CommandSource: "native",
        CommandTargetSessionKey: "agent:main:main",
      }),
      cfg: { session: { store: "/tmp/sessions.json" } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: "/tmp/workspace",
    });

    expect(result.sessionKey).toBe("agent:main:main");
    expect(result.sessionCtx.SessionKey).toBe("agent:main:main");
  });

  it("preserves usage footer mode during fast reset bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-reset-usage-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "existing-fast-reset-usage",
        updatedAt: Date.now(),
        responseUsage: "full",
      },
    });

    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        Body: "/reset",
        RawBody: "/reset",
        CommandBody: "/reset",
        SessionKey: sessionKey,
      }),
      cfg: { session: { store: storePath } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: home,
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.sessionEntry.responseUsage).toBe("full");
  });

  it("rejects a fast reset bootstrap for a model-locked session", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-reset-locked-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "existing-fast-reset-locked",
        updatedAt: Date.now(),
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    });

    expect(() =>
      initFastReplySessionState({
        ctx: buildGetReplyCtx({
          Body: "/reset",
          RawBody: "/reset",
          CommandBody: "/reset",
          SessionKey: sessionKey,
        }),
        cfg: { session: { store: storePath } } as OpenClawConfig,
        agentId: "main",
        commandAuthorized: true,
        workspaceDir: home,
      }),
    ).toThrow(MODEL_SELECTION_LOCKED_RESET_MESSAGE);
    expect(readFastPathSessionEntry(storePath, sessionKey)).toMatchObject({
      sessionId: "existing-fast-reset-locked",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });
  });

  it("maps explicit gateway origin into command context", () => {
    const command = buildFastReplyCommandContext({
      ctx: buildGetReplyCtx({
        Provider: "internal",
        Surface: "internal",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U123",
        From: undefined,
        To: undefined,
        SenderId: "gateway-client",
      }),
      cfg: {} as OpenClawConfig,
      sessionKey: "main",
      isGroup: false,
      triggerBodyNormalized: "/codex bind",
      commandAuthorized: true,
    });

    expect(command.channel).toBe("slack");
    expect(command.channelId).toBe("slack");
    expect(command.from).toBe("gateway-client");
    expect(command.to).toBe("user:U123");
  });

  it("preserves multiline slash skill payloads in fast command context", () => {
    const body = "/skill demo_skill first line\nsecond line";
    const command = buildFastReplyCommandContext({
      ctx: buildGetReplyCtx({
        Body: body,
        RawBody: body,
        CommandBody: body,
      }),
      cfg: {} as OpenClawConfig,
      sessionKey: "main",
      isGroup: false,
      triggerBodyNormalized: body,
      commandAuthorized: true,
    });

    expect(command.commandBodyNormalized).toBe("/skill demo_skill first line\nsecond line");
  });

  it("keeps the existing session for /reset newline soft during fast bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-reset-newline-soft-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "existing-fast-reset-newline-soft",
        updatedAt: Date.now(),
      },
    });

    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        Body: "/reset \nsoft",
        RawBody: "/reset \nsoft",
        CommandBody: "/reset \nsoft",
        SessionKey: sessionKey,
      }),
      cfg: { session: { store: storePath } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: home,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("existing-fast-reset-newline-soft");
  });

  it("keeps the existing session for /reset: soft during fast bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-reset-colon-soft-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "existing-fast-reset-colon-soft",
        updatedAt: Date.now(),
      },
    });

    const result = initFastReplySessionState({
      ctx: buildGetReplyCtx({
        Body: "/reset: soft",
        RawBody: "/reset: soft",
        CommandBody: "/reset: soft",
        SessionKey: sessionKey,
      }),
      cfg: { session: { store: storePath } } as OpenClawConfig,
      agentId: "main",
      commandAuthorized: true,
      workspaceDir: home,
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe("existing-fast-reset-colon-soft");
  });
});
