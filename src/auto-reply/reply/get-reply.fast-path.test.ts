import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../../agents/internal-runtime-context.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  buildFastReplyCommandContext,
  initFastReplySessionState,
  markCompleteReplyConfig,
  withFastReplyConfig,
} from "./get-reply-fast-path.js";
import {
  buildGetReplyCtx,
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
  ensureAgentWorkspace: vi.fn(),
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
        hasOneTurnModelOverride?: boolean;
      }
    | undefined;
  if (!directiveParams) {
    throw new Error("expected directive params");
  }
  return directiveParams;
}

describe("getReplyFromConfig fast test bootstrap", () => {
  beforeAll(async () => {
    await loadGetReplyRuntimeForTest();
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    mocks.ensureAgentWorkspace.mockReset();
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

  it("marks configs through withFastReplyConfig()", async () => {
    const cfg = withFastReplyConfig({ session: { store: "/tmp/sessions.json" } } as OpenClawConfig);

    await expect(getReplyFromConfig(buildGetReplyCtx(), undefined, cfg)).resolves.toEqual({
      text: "ok",
    });
    expect(vi.mocked(loadConfigMock)).not.toHaveBeenCalled();
    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).toHaveBeenCalledOnce();
  });

  it("passes image model overrides as one-turn selections to prepared replies", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-model-directives-"));
    const cfg = markCompleteReplyConfig({
      agents: {
        defaults: {
          model: "openai/gpt-4o",
          models: {
            "openai/gpt-4o": {},
          },
          workspace: home,
        },
      },
      session: { store: path.join(home, "sessions.json") },
    } as OpenClawConfig);
    vi.mocked(resolveDefaultModelMock).mockReturnValueOnce({
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      aliasIndex: emptyAliasIndex(),
    });
    vi.mocked(resolveModelRefFromStringMock).mockReturnValueOnce({
      ref: { provider: "openai", model: "gpt-4o-mini" },
    });

    await expect(
      getReplyFromConfig(buildGetReplyCtx(), { modelOverride: "openai/gpt-4o-mini" }, cfg),
    ).resolves.toEqual({ text: "ok" });

    expect(mocks.resolveReplyDirectives).not.toHaveBeenCalled();
    const preparedReplyParams = requirePreparedReplyParams();
    expect(preparedReplyParams.provider).toBe("openai");
    expect(preparedReplyParams.model).toBe("gpt-4o-mini");
    expect(preparedReplyParams.hasAppliedImageModelOverride).toBe(true);
  });

  it("clears stale ack-only heartbeat pending delivery before replay", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-pending-clear-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "pending-ack",
          updatedAt: Date.now(),
          pendingFinalDelivery: true,
          pendingFinalDeliveryText: "HEARTBEAT_OK",
          pendingFinalDeliveryCreatedAt: 1,
          pendingFinalDeliveryAttemptCount: 4,
          pendingFinalDeliveryLastError: null,
        },
      }),
      "utf8",
    );
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

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"))[sessionKey];
    expect(stored.pendingFinalDelivery).toBeUndefined();
    expect(stored.pendingFinalDeliveryText).toBeUndefined();
    expect(stored.pendingFinalDeliveryAttemptCount).toBeUndefined();
  });

  it("uses ackMaxChars when replaying stale heartbeat pending delivery", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-pending-replay-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "pending-ack-with-remainder",
          updatedAt: Date.now(),
          pendingFinalDelivery: true,
          pendingFinalDeliveryText: "HEARTBEAT_OK short",
        },
      }),
      "utf8",
    );
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
    ).resolves.toEqual({ text: "short" });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"))[sessionKey];
    expect(stored.pendingFinalDelivery).toBe(true);
    expect(stored.pendingFinalDeliveryText).toBe("short");
    expect(stored.pendingFinalDeliveryAttemptCount).toBe(1);
  });

  it("sanitizes stale heartbeat pending delivery before replay", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-pending-sanitize-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "pending-dirty-remainder",
          updatedAt: Date.now(),
          pendingFinalDelivery: true,
          pendingFinalDeliveryText: [
            "HEARTBEAT_OK",
            INTERNAL_RUNTIME_CONTEXT_BEGIN,
            "internal recovery detail",
            INTERNAL_RUNTIME_CONTEXT_END,
            "notify the user",
          ].join("\n"),
        },
      }),
      "utf8",
    );
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
    ).resolves.toEqual({ text: "notify the user" });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"))[sessionKey];
    expect(stored.pendingFinalDeliveryText).toBe("notify the user");
    expect(stored.pendingFinalDeliveryAttemptCount).toBe(1);
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
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [targetSessionKey]: {
          sessionId: "existing-telegram-session",
          thinkingLevel: "xhigh",
          updatedAt: 1,
        },
      }),
      "utf8",
    );
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

    await expect(
      getReplyFromConfig(
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
      ),
    ).resolves.toEqual({ text: "model status" });

    expect(mocks.ensureAgentWorkspace).not.toHaveBeenCalled();
    expect(mocks.initSessionState).not.toHaveBeenCalled();
    expect(vi.mocked(runPreparedReplyMock)).not.toHaveBeenCalled();
    expect(mocks.resolveReplyDirectives).toHaveBeenCalledOnce();
    const directiveParams = requireDirectiveParams();
    expect(directiveParams.sessionKey).toBe(targetSessionKey);
    expect(directiveParams.workspaceDir).toBe("/tmp/workspace");
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

  it("keeps the existing session for /reset newline soft during fast bootstrap", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fast-reset-newline-soft-"));
    const storePath = path.join(home, "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "existing-fast-reset-newline-soft",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );

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
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "existing-fast-reset-colon-soft",
          updatedAt: Date.now(),
        },
      }),
      "utf8",
    );

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
