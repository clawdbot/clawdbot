import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadExactSessionEntry,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import * as sessionPersistence from "./session-entry-persistence.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const { handleCommandsMock } = vi.hoisted(() => ({
  handleCommandsMock: vi.fn(),
}));

vi.mock("./commands.runtime.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
}));

const { maybeResolveNativeSlashCommandFastReply } =
  await import("./get-reply-native-slash-fast-path.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

describe("maybeResolveNativeSlashCommandFastReply", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    handleCommandsMock.mockReset();
  });

  async function resolveNativeDirectiveCommand(body: string) {
    handleCommandsMock.mockResolvedValue({ shouldContinue: true });
    const commandName = body.slice(1).split(/\s+/, 1)[0] ?? "";
    const typing = createTypingController();
    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx: buildTestCtx({
        Body: body,
        BodyForAgent: body,
        RawBody: body,
        CommandBody: body,
        CommandSource: "native",
        CommandAuthorized: true,
        Provider: "telegram",
        Surface: "telegram",
        GatewayClientScopes: ["operator.admin"],
        SessionKey: "telegram:slash:123",
        CommandTargetSessionKey: "agent:main:telegram:123",
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized: true,
          commandName,
          body,
        },
      }),
      cfg: markCompleteReplyConfig({
        session: {
          store: path.join(tempDirs.make("openclaw-native-directive-"), "sessions.json"),
        },
      } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing,
    });

    return { result, typing };
  }

  it("returns native queue validation instead of discarding trailing command arguments", async () => {
    const { result, typing } = await resolveNativeDirectiveCommand("/queue Can you diagnose this?");

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({
        text: 'Unrecognized queue mode "Can". Valid modes: steer, followup, collect, interrupt.',
      }),
    });
    expect(handleCommandsMock).toHaveBeenCalledOnce();
    expect(typing.cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    {
      command: "/think about my deployment plan",
      expected: 'Unrecognized thinking level "about".',
    },
    {
      command: "/verbose explain quantum computing",
      expected: 'Unrecognized verbose level "explain".',
    },
    {
      command: "/trace banana please",
      expected: 'Unrecognized trace level "banana".',
    },
    {
      command: "/fast bananas please",
      expected: 'Unrecognized fast mode "bananas".',
    },
    {
      command: "/reasoning nonsense please",
      expected: 'Unrecognized reasoning level "nonsense".',
    },
  ])("validates every native directive argument: $command", async ({ command, expected }) => {
    const { result } = await resolveNativeDirectiveCommand(command);

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: expect.stringContaining(expected) }),
    });
  });

  it.each([
    { command: "/queue collect please help", expected: 'Unexpected argument "please" for /queue.' },
    { command: "/think high please", expected: 'Unexpected argument "please" for /think.' },
    { command: "/verbose on please", expected: 'Unexpected argument "please" for /verbose.' },
    { command: "/fast on please", expected: 'Unexpected argument "please" for /fast.' },
    {
      command: "/reasoning on please",
      expected: 'Unexpected argument "please" for /reasoning.',
    },
    { command: "/exec host=node please", expected: 'Unexpected argument "please" for /exec.' },
  ])(
    "rejects trailing prose instead of dropping native command $command",
    async ({ command, expected }) => {
      const { result } = await resolveNativeDirectiveCommand(command);

      expect(result).toEqual({
        handled: true,
        reply: expect.objectContaining({ text: expected }),
      });
    },
  );

  it("keeps recognized native settings commands isolated from nested directives", async () => {
    const { result } = await resolveNativeDirectiveCommand("/queue /think high");

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({
        text: expect.stringContaining('Unrecognized queue mode "/think"'),
      }),
    });
  });

  it("marks native /compact terminal replies for delivery under message_tool_only (#90185)", async () => {
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "⚙️ Compaction skipped: no real conversation messages yet • Context 12.1k" },
    });

    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/compact",
      CommandBody: "/compact",
      CommandSource: "native",
      CommandAuthorized: true,
      SessionKey: "telegram:slash:123",
      CommandTargetSessionKey: "agent:main:main",
      CommandTurn: {
        kind: "native",
        source: "native",
        authorized: true,
        commandName: "compact",
        body: "/compact",
      },
    });

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        session: {
          store: path.join(tempDirs.make("openclaw-native-slash-"), "sessions.json"),
        },
      } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing,
    });

    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({
        text: "⚙️ Compaction skipped: no real conversation messages yet • Context 12.1k",
      }),
    });
    if (!result.handled) {
      throw new Error("expected handled");
    }
    if (!result.reply || Array.isArray(result.reply)) {
      throw new Error("expected single reply payload");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("handles authorized text slash commands before model dispatch", async () => {
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "Trajectory exports can include prompts." },
    });

    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/export-trajectory bundle",
      BodyForCommands: "/export-trajectory bundle",
      CommandBody: "/export-trajectory bundle",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:dev:webchat",
      Provider: "webchat",
      Surface: "webchat",
      OriginatingChannel: "webchat",
      ChatType: "direct",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "export-trajectory",
        body: "/export-trajectory bundle",
      },
    });

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        session: {
          store: path.join(tempDirs.make("openclaw-text-slash-"), "sessions.json"),
        },
      } as OpenClawConfig),
      agentId: "dev",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing,
    });

    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({
        text: "Trajectory exports can include prompts.",
      }),
    });
    if (!result.handled || !result.reply || Array.isArray(result.reply)) {
      throw new Error("expected single handled reply");
    }
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });

  it("leaves external text slash commands on the canonical session path", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/export-trajectory bundle",
      BodyForCommands: "/export-trajectory bundle",
      CommandBody: "/export-trajectory bundle",
      CommandSource: "text",
      CommandAuthorized: true,
      SessionKey: "agent:dev:telegram:group:123",
      Provider: "telegram",
      Surface: "telegram",
      ChatType: "group",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "export-trajectory",
        body: "/export-trajectory bundle",
      },
    });

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx,
      cfg: markCompleteReplyConfig({
        session: {
          store: path.join(tempDirs.make("openclaw-external-text-slash-"), "sessions.json"),
        },
      } as OpenClawConfig),
      agentId: "dev",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing,
    });

    expect(result).toEqual({ handled: false });
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(typing.cleanup).not.toHaveBeenCalled();
  });

  it("does not create a session for an unauthorized native command", async () => {
    const storePath = path.join(
      tempDirs.make("openclaw-native-slash-unauthorized-"),
      "sessions.json",
    );
    const sessionKey = "agent:main:telegram:slash:unauthorized";
    handleCommandsMock.mockResolvedValueOnce({
      shouldContinue: false,
      reply: { text: "You are not authorized to use this command." },
    });

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx: buildTestCtx({
        Body: "/config show",
        CommandBody: "/config show",
        CommandSource: "native",
        CommandAuthorized: false,
        Provider: "telegram",
        CommandTargetSessionKey: sessionKey,
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized: false,
          commandName: "config",
          body: "/config show",
        },
      }),
      cfg: markCompleteReplyConfig({ session: { store: storePath } } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: false,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing: createTypingController(),
    });

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: "You are not authorized to use this command." }),
    });
    expect(handleCommandsMock).toHaveBeenCalledOnce();
    expect(loadExactSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });

  it("marks deleted-session initialization conflicts for delivery", async () => {
    vi.spyOn(sessionPersistence, "persistReplySessionEntry").mockResolvedValueOnce({
      status: "lifecycle-invalidated",
      error: 'Session "agent:main:main" was deleted while starting work. Retry.',
    });
    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx: buildTestCtx({
        Body: "/compact",
        CommandBody: "/compact",
        CommandSource: "native",
        CommandAuthorized: true,
        CommandTargetSessionKey: "agent:main:main",
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized: true,
          commandName: "compact",
          body: "/compact",
        },
      }),
      cfg: markCompleteReplyConfig({
        session: {
          store: path.join(tempDirs.make("openclaw-native-slash-conflict-"), "sessions.json"),
        },
      } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing: createTypingController(),
    });

    expect(result.handled).toBe(true);
    if (!result.handled || !result.reply || Array.isArray(result.reply)) {
      throw new Error("expected single handled reply");
    }
    expect(result.reply.text).toContain("was deleted");
    expect(getReplyPayloadMetadata(result.reply)?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("rejects initialization when the session rotates during persistence", async () => {
    vi.spyOn(sessionPersistence, "persistReplySessionEntry").mockResolvedValueOnce({
      status: "lifecycle-invalidated",
      error: 'Session "agent:main:main" changed while starting work. Retry.',
    });
    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx: buildTestCtx({
        Body: "/compact",
        CommandBody: "/compact",
        CommandSource: "native",
        CommandAuthorized: true,
        CommandTargetSessionKey: "agent:main:main",
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized: true,
          commandName: "compact",
          body: "/compact",
        },
      }),
      cfg: markCompleteReplyConfig({
        session: {
          store: path.join(tempDirs.make("openclaw-native-slash-rotation-"), "sessions.json"),
        },
      } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing: createTypingController(),
    });

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: expect.stringContaining("changed while") }),
    });
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("adopts a supported legacy alias before native command initialization", async () => {
    const storePath = path.join(tempDirs.make("openclaw-native-slash-alias-"), "sessions.json");
    const sessionKey = "agent:main:main";
    await replaceSessionEntry({ sessionKey: "Agent:main:main", storePath }, {
      sessionId: "legacy-session",
      updatedAt: 1,
    } as SessionEntry);
    handleCommandsMock.mockImplementationOnce(async (params: { sessionEntry?: unknown }) => {
      expect(params.sessionEntry).toMatchObject({ sessionId: "legacy-session" });
      return { shouldContinue: false, reply: { text: "ok" } };
    });

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx: buildTestCtx({
        Body: "/compact",
        CommandBody: "/compact",
        CommandSource: "native",
        CommandAuthorized: true,
        CommandTargetSessionKey: sessionKey,
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized: true,
          commandName: "compact",
          body: "/compact",
        },
      }),
      cfg: markCompleteReplyConfig({ session: { store: storePath } } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing: createTypingController(),
    });

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: "ok" }),
    });
    expect(handleCommandsMock).toHaveBeenCalledOnce();
  });

  it("does not mutate an archived session during native command initialization", async () => {
    const storePath = path.join(tempDirs.make("openclaw-native-slash-archived-"), "sessions.json");
    const sessionKey = "agent:main:main";
    const archivedEntry = {
      sessionId: "archived-session",
      updatedAt: 1,
      lastInteractionAt: 1,
      archivedAt: 2,
      channel: "telegram",
    };
    await replaceSessionEntry({ sessionKey, storePath }, archivedEntry as SessionEntry);
    const persistedArchivedEntry = loadExactSessionEntry({ sessionKey, storePath })?.entry;

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx: buildTestCtx({
        Body: "/compact",
        CommandBody: "/compact",
        CommandSource: "native",
        CommandAuthorized: true,
        Provider: "telegram",
        CommandTargetSessionKey: sessionKey,
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized: true,
          commandName: "compact",
          body: "/compact",
        },
      }),
      cfg: markCompleteReplyConfig({ session: { store: storePath } } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "openai",
      model: "gpt-5.5",
      workspaceDir: "/tmp/workspace",
      typing: createTypingController(),
    });

    expect(result).toEqual({
      handled: true,
      reply: expect.objectContaining({ text: expect.stringContaining("is archived") }),
    });
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(loadExactSessionEntry({ sessionKey, storePath })?.entry).toEqual(persistedArchivedEntry);
  });

  it("persists fast-path session initialization before command mutation", async () => {
    const storePath = path.join(tempDirs.make("openclaw-native-slash-init-"), "sessions.json");
    const sessionKey = "agent:main:main";
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionId: "session-1",
      updatedAt: 1,
      lastInteractionAt: 1,
      channel: "old-channel",
    } as SessionEntry);
    handleCommandsMock.mockImplementationOnce(async (params: { sessionEntry?: unknown }) => {
      const persisted = loadSessionEntry({ sessionKey, storePath });
      expect(params.sessionEntry).toMatchObject({
        sessionId: "session-1",
        updatedAt: 100,
        lastInteractionAt: 100,
        channel: "telegram",
      });
      expect(persisted).toMatchObject(params.sessionEntry as object);
      return { shouldContinue: false, reply: { text: "ok" } };
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(100);

    try {
      await maybeResolveNativeSlashCommandFastReply({
        ctx: buildTestCtx({
          Body: "/compact",
          CommandBody: "/compact",
          CommandSource: "native",
          CommandAuthorized: true,
          Provider: "telegram",
          CommandTargetSessionKey: sessionKey,
          CommandTurn: {
            kind: "native",
            source: "native",
            authorized: true,
            commandName: "compact",
            body: "/compact",
          },
        }),
        cfg: markCompleteReplyConfig({ session: { store: storePath } } as OpenClawConfig),
        agentId: "main",
        agentDir: "/tmp/agent",
        agentCfg: undefined,
        commandAuthorized: true,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        aliasIndex: { byKey: new Map(), byAlias: new Map() },
        provider: "openai",
        model: "gpt-5.5",
        workspaceDir: "/tmp/workspace",
        typing: createTypingController(),
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
  });
});
