import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsAuthLoginFlowOptions } from "../../commands/models/auth.js";
import type { SessionEntryUpdateOptions } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildBuiltinChatCommands } from "../commands-registry.shared.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const runModelsAuthLoginFlowMock = vi.hoisted(() => vi.fn());
const updateSessionEntryMock = vi.hoisted(() => vi.fn());

vi.mock("../../commands/models/auth.js", () => ({
  runModelsAuthLoginFlow: (opts: unknown) => runModelsAuthLoginFlowMock(opts),
}));
vi.mock("../../config/sessions/session-accessor.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
    "../../config/sessions/session-accessor.js",
  );
  return {
    ...actual,
    updateSessionEntry: (
      scope: { storePath?: string; sessionKey: string },
      update: unknown,
      options: SessionEntryUpdateOptions,
    ) => updateSessionEntryMock({ ...scope, update, ...options }),
  };
});

const { handleLoginCommand } = await import("./commands-login.js");
const { testing } = await import("./commands-login.test-support.js");

function buildLoginParams(
  commandBody: string,
  overrides: {
    command?: Partial<HandleCommandsParams["command"]>;
    ctx?: Partial<HandleCommandsParams["ctx"]>;
    opts?: HandleCommandsParams["opts"];
    sessionKey?: string;
    sessionEntry?: HandleCommandsParams["sessionEntry"];
    sessionStore?: HandleCommandsParams["sessionStore"];
    storePath?: string;
    agentId?: string;
  } = {},
): HandleCommandsParams {
  const params = buildCommandTestParams(
    commandBody,
    {
      commands: { text: true, ownerAllowFrom: ["owner"] },
      channels: { slack: { allowFrom: ["owner"] } },
      session: { mainKey: "main" },
    } as OpenClawConfig,
    {
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "direct:owner",
      AccountId: "workspace-a",
      ChatType: "direct",
      MessageThreadId: "thread-1",
      ...overrides.ctx,
    },
    { workspaceDir: "/tmp/openclaw-login-test" },
  );
  params.sessionKey = overrides.sessionKey ?? "agent:main:slack:channel:C123";
  params.agentId = overrides.agentId;
  params.command = {
    ...params.command,
    channel: "slack",
    channelId: "slack",
    accountId: "workspace-a",
    senderId: "owner",
    senderIsOwner: true,
    isAuthorizedSender: true,
    from: "slack:owner",
    to: "direct:owner",
    ...overrides.command,
  };
  params.opts = overrides.opts;
  if (overrides.sessionEntry !== undefined) {
    params.sessionEntry = overrides.sessionEntry;
    params.sessionStore = overrides.sessionStore ?? {
      [params.sessionKey]: overrides.sessionEntry,
    };
  }
  params.storePath = overrides.storePath;
  return params;
}

function mockSuccessfulLoginFlow(profileId = "openai:owner"): void {
  runModelsAuthLoginFlowMock.mockImplementation(async (opts: ModelsAuthLoginFlowOptions) => {
    await opts.prompter.note?.(
      "Open https://auth.openai.com/device and enter code ABCD-EFGH. Never share this code.",
      "Codex login",
    );
    return {
      providerId: "openai",
      methodId: "device-code",
      profiles: [{ profileId, provider: "openai", mode: "oauth" }],
    };
  });
}

function blockReplyOpts(): NonNullable<HandleCommandsParams["opts"]> {
  return { onBlockReply: vi.fn(async () => {}) };
}

describe("handleLoginCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testing.clearActiveFlows();
  });

  it("registers /login as a built-in command handler", () => {
    expect(buildBuiltinChatCommands().find((entry) => entry.key === "login")).toMatchObject({
      nativeName: "login",
      nativeProviders: ["discord", "slack", "telegram"],
      textAliases: ["/login"],
      scope: "both",
    });
  });

  it("starts Codex device-code login and emits the pairing code through block delivery", async () => {
    const onBlockReply = vi.fn(async () => {});
    mockSuccessfulLoginFlow();

    const result = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: { onBlockReply } }),
      true,
    );

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Codex login complete. Try your request again now." },
    });
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("ABCD-EFGH"),
      }),
    );
    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        method: "device-code",
        agent: "main",
        isRemote: true,
      }),
    );
  });

  it.each(["web", "discord", "slack"] as const)(
    "supports /login codex on the %s command surface",
    async (surface) => {
      const onBlockReply = vi.fn(async () => {});
      mockSuccessfulLoginFlow();
      const targetSessionKey = `agent:main:${surface}:direct:owner`;
      const targetSessionEntry = {
        authProfileOverride: "openai:old-owner",
        sessionId: `sess-${surface}`,
        updatedAt: 1,
      };
      const otherSessionEntry = {
        authProfileOverride: "openai:other-owner",
        sessionId: "sess-other",
        updatedAt: 2,
      };
      const sessionStore = {
        [targetSessionKey]: targetSessionEntry,
        "agent:main:other-session": otherSessionEntry,
      };

      const params = buildLoginParams("/login codex", {
        ctx: {
          Provider: surface,
          Surface: surface,
          OriginatingChannel: surface,
          OriginatingTo: "direct:conversation-1",
          ChatType: "direct",
        },
        command: {
          channel: surface,
          channelId: surface,
          to: "direct:conversation-1",
        },
        opts: { onBlockReply },
        sessionKey: targetSessionKey,
        sessionEntry: targetSessionEntry,
        sessionStore,
      });
      const result = await handleLoginCommand(params, true);

      expect(result?.reply?.text).toBe("Codex login complete. Try your request again now.");
      expect(onBlockReply).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining("https://auth.openai.com/device"),
        }),
      );
      expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
        expect.not.objectContaining({ profileId: expect.any(String) }),
      );
      expect(params.sessionEntry).toMatchObject({
        authProfileOverride: "openai:owner",
        authProfileOverrideSource: "user",
      });
      expect(sessionStore["agent:main:other-session"]).toEqual(otherSessionEntry);
    },
  );

  it("rejects dispatcher-less contexts before starting device-code polling", async () => {
    mockSuccessfulLoginFlow();

    const result = await handleLoginCommand(buildLoginParams("/login openai"), true);

    expect(result?.reply?.text).toBe(
      "Codex login needs a live private response path so the code can be shown before it expires. Use the Web UI or a private chat and send `/login codex` again.",
    );
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("rejects grouped shared-channel login before emitting a device code", async () => {
    const onBlockReply = vi.fn(async () => {});
    mockSuccessfulLoginFlow();
    const params = buildLoginParams("/login codex", {
      ctx: {
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        ChatType: "channel",
      },
      command: {
        channel: "slack",
        to: "channel:C123",
      },
      opts: { onBlockReply },
    });
    params.isGroup = true;

    const result = await handleLoginCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Codex login codes are only sent in a private chat or Web UI session. Open a private chat with OpenClaw and send `/login codex` there.",
      },
    });
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("moves a pinned session to the canonical profile returned by login", async () => {
    mockSuccessfulLoginFlow("openai:new-owner@example.com");
    const previousEntry = {
      authProfileOverride: "openai:owner@example.com",
      sessionId: "sess-owner",
      updatedAt: 1,
    };
    updateSessionEntryMock.mockImplementationOnce(
      async (params: {
        update: (
          entry: SessionEntry,
        ) => Partial<SessionEntry> | null | Promise<Partial<SessionEntry> | null>;
      }) => {
        const patch = await params.update({ ...previousEntry });
        return patch ? { ...previousEntry, ...patch } : previousEntry;
      },
    );
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: previousEntry,
      storePath: "/tmp/openclaw-login-sessions.json",
    });

    await handleLoginCommand(params, true);

    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ profileId: expect.any(String) }),
    );
    expect(params.sessionEntry).toMatchObject({
      authProfileOverride: "openai:new-owner@example.com",
      authProfileOverrideSource: "user",
    });
    expect(updateSessionEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:slack:channel:C123",
        storePath: "/tmp/openclaw-login-sessions.json",
        requireWriteSuccess: true,
      }),
    );
  });

  it("reports partial success when login returns no requested-provider profile", async () => {
    runModelsAuthLoginFlowMock.mockResolvedValue({
      providerId: "openai",
      methodId: "device-code",
      profiles: [],
    });

    const result = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );

    expect(result?.reply?.text).toBe(
      "Codex login completed, but this session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
    );
  });

  it("rejects empty profile identifiers returned by login", async () => {
    runModelsAuthLoginFlowMock.mockResolvedValue({
      providerId: "openai",
      methodId: "device-code",
      profiles: [{ profileId: " ", provider: "openai", mode: "oauth" }],
    });

    const result = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );

    expect(result?.reply?.text).toBe(
      "Codex login did not complete. Send `/login codex` to request a new code.",
    );
  });

  it("normalizes returned login identifiers before switching profiles", async () => {
    runModelsAuthLoginFlowMock.mockResolvedValue({
      providerId: " openai ",
      methodId: " device-code ",
      defaultModel: " openai/gpt-5.4 ",
      profiles: [{ profileId: " openai:owner@example.com ", provider: " openai ", mode: "oauth" }],
    });
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: {
        authProfileOverride: "openai:old-owner@example.com",
        sessionId: "sess-owner",
        updatedAt: 1,
      },
    });

    const result = await handleLoginCommand(params, true);

    expect(result?.reply?.text).toBe("Codex login complete. Try your request again now.");
    expect(params.sessionEntry?.authProfileOverride).toBe("openai:owner@example.com");
  });

  it("marks a same-profile explicit login as user-selected", async () => {
    mockSuccessfulLoginFlow("openai:owner@example.com");
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: {
        authProfileOverride: "openai:owner@example.com",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 3,
        sessionId: "sess-owner",
        updatedAt: 1,
      },
    });

    await handleLoginCommand(params, true);

    expect(params.sessionEntry).toMatchObject({
      authProfileOverride: "openai:owner@example.com",
      authProfileOverrideSource: "user",
    });
    expect(params.sessionEntry?.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("does not pass unrelated pinned profiles into OpenAI login", async () => {
    mockSuccessfulLoginFlow();

    await handleLoginCommand(
      buildLoginParams("/login codex", {
        opts: blockReplyOpts(),
        sessionEntry: {
          authProfileOverride: "anthropic:owner@example.com",
          sessionId: "sess-owner",
          updatedAt: 1,
        },
      }),
      true,
    );

    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        profileId: expect.any(String),
      }),
    );
  });

  it("reports partial success and restores the session when profile persistence fails", async () => {
    mockSuccessfulLoginFlow("openai:new-owner@example.com");
    updateSessionEntryMock.mockRejectedValueOnce(new Error("write failed"));
    const previousEntry = {
      authProfileOverride: "openai:old-owner@example.com",
      authProfileOverrideSource: "user" as const,
      sessionId: "sess-owner",
      updatedAt: 1,
    };
    const sessionStore = {
      "agent:main:slack:channel:C123": previousEntry,
      "agent:main:other-session": {
        authProfileOverride: "openai:other-owner@example.com",
        sessionId: "sess-other",
        updatedAt: 2,
      },
    };
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: previousEntry,
      sessionStore,
      storePath: "/tmp/openclaw-login-sessions.json",
    });

    const result = await handleLoginCommand(params, true);

    expect(result?.reply?.text).toBe(
      "Codex login completed, but this session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
    );
    expect(params.sessionEntry).toBe(previousEntry);
    expect(sessionStore["agent:main:slack:channel:C123"]).toBe(previousEntry);
    expect(sessionStore["agent:main:other-session"]?.authProfileOverride).toBe(
      "openai:other-owner@example.com",
    );
  });

  it("does not overwrite a profile selected while device login is in progress", async () => {
    mockSuccessfulLoginFlow("openai:new-owner@example.com");
    const previousEntry = {
      authProfileOverride: "openai:old-owner@example.com",
      authProfileOverrideSource: "user" as const,
      sessionId: "sess-owner",
      updatedAt: 1,
    };
    const concurrentlySelectedEntry = {
      ...previousEntry,
      authProfileOverride: "openai:concurrent-owner@example.com",
      updatedAt: 2,
    };
    updateSessionEntryMock.mockImplementationOnce(
      async (params: { update: (entry: SessionEntry) => Partial<SessionEntry> | null }) => {
        const patch = params.update({ ...concurrentlySelectedEntry });
        return patch ? { ...concurrentlySelectedEntry, ...patch } : concurrentlySelectedEntry;
      },
    );
    const sessionStore = {
      "agent:main:slack:channel:C123": previousEntry,
    };
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: previousEntry,
      sessionStore,
      storePath: "/tmp/openclaw-login-sessions.json",
    });

    const result = await handleLoginCommand(params, true);

    expect(result?.reply?.text).toBe(
      "Codex login completed, but this session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
    );
    expect(params.sessionEntry).toBe(previousEntry);
    expect(sessionStore["agent:main:slack:channel:C123"]).toBe(previousEntry);
  });

  it("revalidates an unchanged profile after device login", async () => {
    mockSuccessfulLoginFlow("openai:owner@example.com");
    const previousEntry = {
      authProfileOverride: "openai:owner@example.com",
      authProfileOverrideSource: "user" as const,
      sessionId: "sess-owner",
      updatedAt: 1,
    };
    const concurrentlySelectedEntry = {
      ...previousEntry,
      authProfileOverride: "openai:concurrent-owner@example.com",
      updatedAt: 2,
    };
    updateSessionEntryMock.mockImplementationOnce(
      async (params: { update: (entry: SessionEntry) => Partial<SessionEntry> | null }) => {
        const patch = params.update({ ...concurrentlySelectedEntry });
        return patch ? { ...concurrentlySelectedEntry, ...patch } : concurrentlySelectedEntry;
      },
    );
    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      sessionEntry: previousEntry,
      storePath: "/tmp/openclaw-login-sessions.json",
    });

    const result = await handleLoginCommand(params, true);

    expect(result?.reply?.text).toBe(
      "Codex login completed, but this session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
    );
    expect(params.sessionEntry).toBe(previousEntry);
  });

  it("dedupes an active flow for the same channel thread and provider", async () => {
    let resolveLogin!: () => void;
    runModelsAuthLoginFlowMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLogin = () =>
            resolve({
              providerId: "openai",
              methodId: "device-code",
              profiles: [],
            });
        }),
    );

    const first = handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );
    const second = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );

    expect(second).toEqual({
      shouldContinue: false,
      reply: {
        text: "A Codex login code is already active for this chat or channel. Complete it, or wait for it to expire before requesting a new one.",
      },
    });
    resolveLogin();
    await first;
  });

  it("rejects non-owner senders before starting login", async () => {
    const result = await handleLoginCommand(
      buildLoginParams("/login codex", {
        command: { senderIsOwner: false },
      }),
      true,
    );

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Only a configured OpenClaw owner/admin can start Codex login from this channel.",
      },
    });
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("rejects allowlisted senders when no command owner is configured", async () => {
    const params = buildLoginParams("/login codex", {
      command: {
        senderIsOwner: true,
        isAuthorizedSender: true,
      },
    });
    params.cfg = {
      ...params.cfg,
      commands: { text: true },
    } as OpenClawConfig;

    const result = await handleLoginCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "Only a configured OpenClaw owner/admin can start Codex login from this channel.",
      },
    });
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("normalizes Codex login aliases to the OpenAI provider", async () => {
    mockSuccessfulLoginFlow();

    await handleLoginCommand(
      buildLoginParams("/login openai-codex", { opts: blockReplyOpts() }),
      true,
    );

    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" }),
    );
  });

  it("returns a friendly error for unsupported providers", async () => {
    const result = await handleLoginCommand(buildLoginParams("/login anthropic"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Unsupported login provider. Use `/login codex`." },
    });
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });
});
