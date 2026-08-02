// Tests get-reply fast-path command handling before full agent dispatch.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayAgentRunApprovalHost } from "../../agents/agent-run-approval.gateway.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  MODEL_SELECTION_LOCKED_RESET_MESSAGE,
  ModelSelectionLockedError,
} from "../../sessions/model-overrides.js";
import { listSessionStateEventsSince } from "../../sessions/session-state-events.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { handleGoalCommand } from "./commands-goal.js";
import {
  markCompleteReplyConfig,
  withFastReplyConfig,
} from "./get-reply-fast-path.test-support.js";
import {
  buildGetReplyCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  expectResolvedTelegramTimezone,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

type LoadModelCatalogFn =
  typeof import("../../agents/prepared-model-catalog.js").loadPreparedModelCatalog;
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

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalog: mocks.loadModelCatalog,
}));

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
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ storePath, sessionKey }, entry as unknown as SessionEntry);
  }
}

function readFastPathSessionEntry(storePath: string, sessionKey: string): Record<string, unknown> {
  return (
    (loadSessionEntry({ storePath, sessionKey }) as unknown as
      | Record<string, unknown>
      | undefined) ?? {}
  );
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
    closeOpenClawStateDatabaseForTest();
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

    await expect(
      getReplyFromConfig(
        buildGetReplyCtx({ ApprovalReviewerDeviceId: "device-reviewer" }),
        undefined,
        cfg,
      ),
    ).resolves.toEqual({ text: "ok" });
    expect(vi.mocked(loadConfigMock)).not.toHaveBeenCalled();
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
    const preparedReplyParams = requirePreparedReplyParams();
    expect(preparedReplyParams.cfg).toBe(cfg);
    expect(preparedReplyParams.approvalHost).toBeDefined();
    expect(preparedReplyParams.approvalHost).not.toBe(gatewayAgentRunApprovalHost);
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
        pendingFinalDelivery: {
          kind: "replayable",
          text: "HEARTBEAT_OK",
          createdAt: 1,
          intentId: "stale-heartbeat-intent",
        },
      },
    });
    const cfg = withFastReplyConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          workspace: home,
          heartbeat: {},
        },
      },
      session: { store: storePath },
    } as OpenClawConfig);

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), { isHeartbeat: true }, cfg),
    ).resolves.toEqual({ text: "ok" });

    const stored = readFastPathSessionEntry(storePath, sessionKey);
    expect(stored.pendingFinalDelivery).toBeUndefined();
  });

  it("clears short heartbeat pending delivery under the fixed ack policy", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-pending-replay-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "pending-ack-with-remainder",
        updatedAt: Date.now(),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "HEARTBEAT_OK short",
          createdAt: 1,
        },
      },
    });
    const cfg = withFastReplyConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          workspace: home,
          heartbeat: {},
        },
      },
      session: { store: storePath },
    } as OpenClawConfig);

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), { isHeartbeat: true }, cfg),
    ).resolves.toEqual({ text: "ok" });

    const stored = readFastPathSessionEntry(storePath, sessionKey);
    expect(stored.pendingFinalDelivery).toBeUndefined();
  });

  it("does not replay stale heartbeat pending delivery", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-pending-suppress-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await seedFastPathSessionStore(storePath, {
      [sessionKey]: {
        sessionId: "pending-user-final",
        updatedAt: Date.now() - 60_000,
        pendingFinalDelivery: {
          kind: "replayable",
          text: "private prior user answer",
          createdAt: 1,
        },
      },
    });
    const cfg = withFastReplyConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          workspace: home,
          heartbeat: {},
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
    expect(stored.pendingFinalDelivery).toMatchObject({
      kind: "replayable",
      text: "private prior user answer",
    });
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
    expect(mocks.loadModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        agentId: "main",
        agentDir: expect.any(String),
      }),
    );
    expect(mocks.loadModelCatalog.mock.calls[0]?.[0]).toMatchObject({
      workspaceDir: "/tmp/workspace",
    });
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
    expect(mocks.loadModelCatalog).toHaveBeenCalledExactlyOnceWith({
      config: cfg,
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      readOnly: true,
    });
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
    expect(mocks.loadModelCatalog).toHaveBeenCalledExactlyOnceWith({
      config: cfg,
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      readOnly: true,
    });
    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).not.toHaveBeenCalled();
  });

  it("handles native slash directives before workspace bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-native-slash-fast-"));
    const targetSessionKey = "agent:main:telegram:123";
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "state"));
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
        SessionCreation: {
          via: "operator",
          actor: { type: "human", id: "profile-native-slash" },
        },
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
    expect(listSessionStateEventsSince(targetSessionKey, "main", 0, 20).events).toContainEqual(
      expect.objectContaining({
        kind: "created",
        actorType: "human",
        actorId: "profile-native-slash",
      }),
    );
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
          ApprovalReviewerDeviceId: "device-reviewer",
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
      expectDefined(
        vi.mocked(runPreparedReplyMock).mock.invocationCallOrder[0],
        "vi.mocked(runPreparedReplyMock).mock.invocationCallOrder[0] test invariant",
      ),
    );
    expect(
      (readFastPathSessionEntry(storePath, targetSessionKey) as unknown as SessionEntry).goal
        ?.objective,
    ).toBe("/status");
    const preparedReplyParams = requirePreparedReplyParams();
    const inlineApprovalHosts = mocks.handleInlineActions.mock.calls.map(
      ([params]) => (params as { approvalHost?: unknown }).approvalHost,
    );
    expect(inlineApprovalHosts).toEqual([
      preparedReplyParams.approvalHost,
      preparedReplyParams.approvalHost,
    ]);
    expect(preparedReplyParams.command.commandBodyNormalized).toBe(continuationPrompt);
    expect(preparedReplyParams.sessionCtx.BodyForAgent).toBe(continuationPrompt);
    expect(mocks.handleInlineActions).toHaveBeenCalledTimes(2);
  });
});
