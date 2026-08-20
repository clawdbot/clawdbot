// Tests plugin command dispatch and plugin-scoped command aliases.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { parseSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { registerPluginCommandInRegistry } from "../../plugins/command-registration.js";
import {
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandExecutionReplyOptions,
} from "../../plugins/plugin-command-runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { PluginCommandContext, PluginCommandResult } from "../../plugins/types.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { handlePluginCommand } from "./commands-plugin.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { shouldBypassPluginOwnedBindingForCommand } from "./dispatch-from-config.plugin-binding.js";

const compactEmbeddedAgentSessionMock = vi.hoisted(() => vi.fn());

vi.mock("./commands-compact.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./commands-compact.runtime.js")>()),
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
  isEmbeddedAgentRunAbortableForCompaction: () => false,
}));

let registry: PluginRegistry;

function registerTestCommand(
  result: PluginCommandResult = { text: "from plugin" },
  overrides: Partial<Parameters<typeof registerPluginCommandInRegistry>[2]> = {},
) {
  const handler = vi.fn(async (_ctx: PluginCommandContext) => result);
  expect(
    registerPluginCommandInRegistry(registry, "test-plugin", {
      name: "card",
      description: "Card command",
      handler,
      ...overrides,
    }),
  ).toEqual({ ok: true });
  return handler;
}

function firstCommandContext(handler: ReturnType<typeof registerTestCommand>) {
  return expectDefined(handler.mock.calls[0]?.[0], "plugin command handler context");
}

function buildPluginParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
): HandleCommandsParams {
  return {
    cfg,
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      GatewayClientScopes: ["operator.write", "operator.pairing"],
      AccountId: undefined,
    },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderId: "owner",
      channel: "whatsapp",
      channelId: "whatsapp",
      from: "test-user",
      to: "test-bot",
    },
    sessionKey: "agent:main:whatsapp:direct:test-user",
    sessionEntry: {
      sessionId: "session-plugin-command",
      updatedAt: Date.now(),
    },
    provider: "openai",
    model: "gpt-5.4",
    workspaceDir: "/tmp/openclaw-plugin-command",
    contextTokens: 10_000,
    isGroup: false,
    resolveDefaultThinkingLevel: async () => "medium",
  } as unknown as HandleCommandsParams;
}

describe("handlePluginCommand", () => {
  beforeEach(() => {
    compactEmbeddedAgentSessionMock.mockReset();
    resetPluginRuntimeStateForTest();
    registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
  });
  afterEach(() => resetPluginRuntimeStateForTest());

  it("dispatches registered plugin commands with gateway scopes and session metadata", async () => {
    const handler = registerTestCommand();

    const result = await handlePluginCommand(
      buildPluginParams("/card", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("from plugin");
    expect(handler).toHaveBeenCalledTimes(1);
    const commandParams = firstCommandContext(handler);
    expect(commandParams.gatewayClientScopes).toEqual(["operator.write", "operator.pairing"]);
    expect(commandParams.sessionKey).toBe("agent:main:whatsapp:direct:test-user");
    expect(commandParams.sessionId).toBe("session-plugin-command");
    expect(commandParams.commandBody).toBe("/card");
  });

  it("compacts the bound session through the host runtime and records fresh tokens", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-compact-"));
    const sessionKey = "agent:main:whatsapp:direct:test-user";
    const storePath = path.join(tempDir, "sessions.json");
    const handler = vi.fn(async (ctx: PluginCommandContext) => ({
      text: JSON.stringify(await ctx.runtimeContext?.compactCurrent?.()),
    }));
    expect(
      registerPluginCommandInRegistry(registry, "test-plugin", {
        name: "card",
        description: "Card command",
        handler,
      }),
    ).toEqual({ ok: true });
    compactEmbeddedAgentSessionMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      compactionKind: "native-harness",
      result: { summary: "", firstKeptEntryId: "", tokensBefore: 900, tokensAfter: 321 },
    });
    const params = buildPluginParams("/card", {
      commands: { text: true },
      session: { store: storePath },
    } as OpenClawConfig);
    params.storePath = storePath;
    const entry = { sessionId: "session-plugin-command", updatedAt: Date.now() };
    params.sessionStore = { [sessionKey]: entry };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    params.workspaceDir = tempDir;

    try {
      const response = await handlePluginCommand(params, true);

      expect(response?.reply?.text).toBe(
        JSON.stringify({ compacted: true, tokensBefore: 900, tokensAfter: 321 }),
      );
      expect(params.sessionStore[sessionKey]).toMatchObject({
        compactionCount: 1,
        totalTokens: 321,
        totalTokensFresh: true,
      });
      expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject({
        compactionCount: 1,
        totalTokens: 321,
        totalTokensFresh: true,
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("omits session compaction when no bound session exists", async () => {
    const handler = registerTestCommand();
    const params = buildPluginParams("/card", { commands: { text: true } } as OpenClawConfig);
    params.sessionEntry = undefined;

    await handlePluginCommand(params, true);

    expect(firstCommandContext(handler).runtimeContext?.compactCurrent).toBeUndefined();
  });

  it("blocks session compaction for an unauthorized public command", async () => {
    const handler = vi.fn(async (ctx: PluginCommandContext) => ({
      text: JSON.stringify(await ctx.runtimeContext?.compactCurrent?.()),
    }));
    registerTestCommand(undefined, {
      requireAuth: false,
      handler,
    });
    const params = buildPluginParams("/card", { commands: { text: true } } as OpenClawConfig);
    params.command = { ...params.command, isAuthorizedSender: false };

    const result = await handlePluginCommand(params, true);

    expect(result?.reply?.text).toBe(
      JSON.stringify({ compacted: false, reason: "compaction requires authorization" }),
    );
    expect(
      expectDefined(handler.mock.calls[0]?.[0], "public command context").runtimeContext
        ?.compactCurrent,
    ).toBeTypeOf("function");
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("closes retained session compaction when the command handler settles", async () => {
    let retained: NonNullable<PluginCommandContext["runtimeContext"]>["compactCurrent"];
    registerTestCommand(undefined, {
      handler: async (ctx) => {
        retained = ctx.runtimeContext?.compactCurrent;
        return { text: "saved" };
      },
    });

    await handlePluginCommand(
      buildPluginParams("/card", { commands: { text: true } } as OpenClawConfig),
      true,
    );

    await expect(expectDefined(retained, "retained compact capability")()).resolves.toEqual({
      compacted: false,
      reason: "command invocation closed",
    });
    expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
  });

  it("closes unawaited session compaction when the command handler settles", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-compact-detached-"));
    const sessionKey = "agent:main:whatsapp:direct:test-user";
    const storePath = path.join(tempDir, "sessions.json");
    const entry = { sessionId: "session-plugin-command", updatedAt: Date.now() };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    let releasePreparation = () => {};
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let detached:
      | ReturnType<
          NonNullable<NonNullable<PluginCommandContext["runtimeContext"]>["compactCurrent"]>
        >
      | undefined;
    registerTestCommand(undefined, {
      handler: async (ctx) => {
        detached = expectDefined(ctx.runtimeContext?.compactCurrent, "compact capability")();
        return { text: "started" };
      },
    });

    const params = buildPluginParams("/card", {
      commands: { text: true },
      session: { store: storePath },
    } as OpenClawConfig);
    params.storePath = storePath;
    params.sessionStore = { [sessionKey]: entry };
    params.resolveDefaultThinkingLevel = async () => {
      await preparation;
      return "medium";
    };

    try {
      await handlePluginCommand(params, true);
      releasePreparation();
      await expect(expectDefined(detached, "detached compact result")).resolves.toEqual({
        compacted: false,
        reason: "command invocation closed",
      });
      expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
    } finally {
      releasePreparation();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects session compaction when the bound session disappeared", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-compact-gone-"));
    const sessionKey = "agent:main:whatsapp:direct:test-user";
    const storePath = path.join(tempDir, "sessions.json");
    const entry = { sessionId: "session-plugin-command", updatedAt: Date.now() };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    registerTestCommand(undefined, {
      handler: async (ctx) => {
        await deleteSessionEntryLifecycle({
          storePath,
          archiveTranscript: false,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        });
        return { text: JSON.stringify(await ctx.runtimeContext?.compactCurrent?.()) };
      },
    });
    const params = buildPluginParams("/card", {
      commands: { text: true },
      session: { store: storePath },
    } as OpenClawConfig);
    params.storePath = storePath;
    params.sessionStore = { [sessionKey]: entry };

    try {
      const response = await handlePluginCommand(params, true);
      expect(response?.reply?.text).toBe(
        JSON.stringify({ compacted: false, reason: "command session changed" }),
      );
      expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects session compaction when its lifecycle changes during admission", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-compact-race-"));
    const sessionKey = "agent:main:whatsapp:direct:test-user";
    const storePath = path.join(tempDir, "sessions.json");
    const entry = {
      sessionId: "session-plugin-command",
      lifecycleRevision: "revision-1",
      updatedAt: Date.now(),
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    registerTestCommand(undefined, {
      handler: async (ctx) => ({
        text: JSON.stringify(await ctx.runtimeContext?.compactCurrent?.()),
      }),
    });
    const params = buildPluginParams("/card", {
      commands: { text: true },
      session: { store: storePath },
    } as OpenClawConfig);
    params.storePath = storePath;
    params.sessionStore = { [sessionKey]: entry };
    params.resolveDefaultThinkingLevel = async () => {
      await replaceSessionEntry(
        { storePath, sessionKey },
        { ...entry, lifecycleRevision: "revision-2" },
      );
      return "medium";
    };

    try {
      const response = await handlePluginCommand(params, true);
      expect(response?.reply?.text).toBe(
        JSON.stringify({ compacted: false, reason: "command session changed" }),
      );
      expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects session replacement before the compact capability is invoked", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-compact-rebound-"));
    const sessionKey = "agent:main:whatsapp:direct:test-user";
    const storePath = path.join(tempDir, "sessions.json");
    const entry = {
      sessionId: "session-plugin-command",
      lifecycleRevision: "revision-1",
      updatedAt: Date.now(),
    };
    const replacement = {
      ...entry,
      sessionId: "replacement-session",
      lifecycleRevision: "revision-2",
    };
    await replaceSessionEntry({ storePath, sessionKey }, entry);
    const params = buildPluginParams("/card", {
      commands: { text: true },
      session: { store: storePath },
    } as OpenClawConfig);
    params.storePath = storePath;
    params.sessionStore = { [sessionKey]: entry };
    registerTestCommand(undefined, {
      handler: async (ctx) => {
        Object.assign(
          expectDefined(
            expectDefined(params.sessionStore, "session store")[sessionKey],
            "session entry",
          ),
          replacement,
        );
        await replaceSessionEntry({ storePath, sessionKey }, replacement);
        return { text: JSON.stringify(await ctx.runtimeContext?.compactCurrent?.()) };
      },
    });

    try {
      const response = await handlePluginCommand(params, true);
      expect(response?.reply?.text).toBe(
        JSON.stringify({ compacted: false, reason: "command session changed" }),
      );
      expect(compactEmbeddedAgentSessionMock).not.toHaveBeenCalled();
      expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject(replacement);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers the target session entry from sessionStore for plugin command metadata", async () => {
    const handler = registerTestCommand();

    const params = buildPluginParams("/card", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    params.agentId = "requester";
    params.sessionKey = "agent:target:whatsapp:direct:test-user";
    params.sessionEntry = {
      sessionId: "wrapper-session",
      sessionFile: "/tmp/wrapper-session.jsonl",
      updatedAt: Date.now(),
    } as HandleCommandsParams["sessionEntry"];
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "target-session",
        sessionFile: "/tmp/target-session.jsonl",
        authProfileOverride: "openai:owner@example.com",
        updatedAt: Date.now(),
      },
    };

    await handlePluginCommand(params, true);

    expect(handler).toHaveBeenCalledTimes(1);
    const commandParams = firstCommandContext(handler);
    expect(commandParams.agentId).toBe("target");
    expect(commandParams.sessionId).toBe("target-session");
    expect(commandParams.sessionTarget).toMatchObject({
      agentId: "target",
      sessionId: "target-session",
      sessionKey: params.sessionKey,
    });
    expect(parseSqliteSessionFileMarker(commandParams.sessionFile)).toMatchObject({
      agentId: "target",
      sessionId: "target-session",
    });
  });

  it("uses the process-local transcript store for incognito plugin commands", async () => {
    const handler = registerTestCommand();

    const params = buildPluginParams("/card", {
      commands: { text: true },
      session: { store: "/tmp/durable/{agentId}/sessions.json" },
    } as OpenClawConfig);
    params.agentId = "main";
    params.sessionKey = "agent:main:dashboard:incognito-plugin-command";
    params.storePath = "/tmp/durable/main/sessions.json";
    params.sessionStore = {
      [params.sessionKey]: {
        sessionId: "incognito-session",
        incognito: true,
        updatedAt: Date.now(),
      },
    };

    await handlePluginCommand(params, true);

    const commandParams = firstCommandContext(handler);
    const expectedStorePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
    expect(commandParams.sessionTarget?.storePath).toBe(expectedStorePath);
    expect(parseSqliteSessionFileMarker(commandParams.sessionFile)?.storePath).toBe(
      expectedStorePath,
    );
  });

  it("keeps the current agent for unqualified global session keys", async () => {
    const handler = registerTestCommand();

    const params = buildPluginParams("/card", {
      commands: { text: true },
      session: { store: "/tmp/durable/{agentId}/sessions.json" },
    } as OpenClawConfig);
    params.agentId = "other";
    params.sessionKey = "global";

    await handlePluginCommand(params, true);

    const commandParams = firstCommandContext(handler);
    expect(commandParams.sessionTarget).toMatchObject({
      agentId: "other",
      storePath: "/tmp/durable/other/sessions.json",
    });
  });

  it("continues the agent without leaking continueAgent into the reply payload", async () => {
    registerTestCommand({
      text: "from plugin",
      continueAgent: true,
    });

    const result = await handlePluginCommand(
      buildPluginParams("/card", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(result).toEqual({
      shouldContinue: true,
      reply: { text: "from plugin" },
    });
  });

  it("enforces requiredScopes through the command handler path", async () => {
    const handler = vi.fn().mockResolvedValue({
      text: "approved",
      continueAgent: true,
    });
    expect(
      registerPluginCommandInRegistry(registry, "approval-plugin", {
        name: "approve-deploy",
        description: "Approve deployment",
        requiredScopes: ["operator.approvals"],
        handler,
      }),
    ).toEqual({ ok: true });

    const denied = await handlePluginCommand(
      buildPluginParams("/approve-deploy", {
        commands: { text: true },
        channels: { whatsapp: { allowFrom: ["*"] } },
      } as OpenClawConfig),
      true,
    );

    expect(denied).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ This command requires gateway scope: operator.approvals." },
    });
    expect(handler).not.toHaveBeenCalled();

    const allowedParams = buildPluginParams("/approve-deploy", {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig);
    allowedParams.ctx.GatewayClientScopes = ["operator.approvals"];

    const allowed = await handlePluginCommand(allowedParams, true);

    expect(allowed).toEqual({
      shouldContinue: true,
      reply: { text: "approved" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("carries one binding selection into dispatch without rematching a replacement registry", async () => {
    const originalHandler = registerTestCommand();
    const replyOptions: NonNullable<HandleCommandsParams["opts"]> &
      PluginCommandExecutionReplyOptions = {};
    const cfg = { commands: { text: true } } as OpenClawConfig;
    expect(
      shouldBypassPluginOwnedBindingForCommand(
        {
          Body: "/card",
          CommandAuthorized: true,
          CommandSource: "text",
          Provider: "whatsapp",
          Surface: "whatsapp",
        } as never,
        cfg,
        replyOptions,
      ),
    ).toBe(true);
    expect(replyOptions[PLUGIN_COMMAND_DISPATCH]?.kind).toBe("plugin");

    const replacement = createEmptyPluginRegistry();
    const replacementHandler = vi.fn(async () => ({ text: "replacement" }));
    expect(
      registerPluginCommandInRegistry(replacement, "replacement", {
        name: "card",
        description: "Replacement card",
        handler: replacementHandler,
      }),
    ).toEqual({ ok: true });
    setActivePluginRegistry(replacement);
    const params = buildPluginParams("/card", cfg);
    params.opts = replyOptions;

    const result = await handlePluginCommand(params, true);

    expect(result?.reply?.text).toContain("registry changed");
    expect(originalHandler).not.toHaveBeenCalled();
    expect(replacementHandler).not.toHaveBeenCalled();
  });

  it("treats an explicit non-plugin catalog winner as terminal for plugin matching", async () => {
    const handler = registerTestCommand();
    const params = buildPluginParams("/card", { commands: { text: true } } as OpenClawConfig);
    params.opts = {
      [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" },
    } as NonNullable<HandleCommandsParams["opts"]> & PluginCommandExecutionReplyOptions;

    await expect(handlePluginCommand(params, true)).resolves.toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });
});
