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
  runModelsAuthLoginFlowCore: (opts: unknown) => runModelsAuthLoginFlowMock(opts),
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
    provider?: string;
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
  params.agentId = overrides.agentId ?? params.agentId;
  params.provider = overrides.provider ?? "openai";
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
      modelAccess: "enabled",
      authRefresh: "refreshed",
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
      reply: {
        text: "OpenAI login complete. Available OpenAI models will update automatically. Your default model is unchanged. Use /models to browse.",
      },
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
        ownerPluginId: "openai",
        credentialOnly: true,
        agent: "main",
        isRemote: true,
      }),
    );
  });

  it("starts xAI device login through the provider-owned OAuth method", async () => {
    const onBlockReply = vi.fn(async () => {});
    runModelsAuthLoginFlowMock.mockImplementation(async (opts: ModelsAuthLoginFlowOptions) => {
      await opts.prompter.note("URL: https://accounts.x.ai/device\nCode: XAI-CODE", "xAI OAuth");
      return {
        providerId: "xai",
        methodId: "oauth",
        modelAccess: "enabled",
        authRefresh: "refreshed",
        profiles: [{ profileId: "xai:owner", provider: "xai", mode: "oauth" }],
      };
    });

    const result = await handleLoginCommand(
      buildLoginParams("/login xai", { opts: { onBlockReply }, provider: "xai" }),
      true,
    );

    expect(result?.reply?.text).toBe(
      "xAI (Grok) login complete. Available xAI (Grok) models will update automatically. Your default model is unchanged. Use /models to browse.",
    );
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("XAI-CODE") }),
    );
    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "xai",
        method: "oauth",
        ownerPluginId: "xai",
        credentialOnly: true,
        isRemote: true,
      }),
    );
  });

  it("hands guided secret login to the masked Control UI wizard", async () => {
    const result = await handleLoginCommand(buildLoginParams("/login groq"), true);

    expect(result?.reply?.text).toBe(
      "Groq API key needs secure input that chat must not store. Open Control UI → Models → Connect, then choose “Groq API key” under Connect with an API key or token.",
    );
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("hands browser sign-in to the Control UI sign-in section", async () => {
    const result = await handleLoginCommand(buildLoginParams("/login github-copilot"), true);

    expect(result?.reply?.text).toBe(
      "GitHub Copilot needs provider sign-in. Open Control UI → Models → Connect, then choose “GitHub Copilot” under Sign in.",
    );
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("hands provider setup to the shared Control UI setup wizard", async () => {
    const result = await handleLoginCommand(buildLoginParams("/login vllm"), true);

    expect(result?.reply?.text).toBe(
      "vLLM needs provider setup. Open Control UI → Models → Connect, then choose “vLLM” under Provider setup.",
    );
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("lists exact choices when a provider family has multiple channel logins", async () => {
    const result = await handleLoginCommand(buildLoginParams("/login minimax"), true);

    expect(result?.reply?.text).toBe(
      "Choose one provider login: `/login minimax-cn-oauth`, `/login minimax-global-oauth`.",
    );
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
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

      expect(result?.reply?.text).toBe(
        "OpenAI login complete. Available OpenAI models will update automatically. Your default model is unchanged. Use /models to browse.",
      );
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

    const result = await handleLoginCommand(buildLoginParams("/login codex"), true);

    expect(result?.reply?.text).toBe(
      "OpenAI login needs a live private response path so the code can be shown before it expires. Use the Control UI or a private chat and send `/login codex` again.",
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
        text: "Provider login codes are only sent in a private chat or Control UI session. Open a private chat with OpenClaw and send `/login codex` there.",
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
      modelAccess: "already-visible",
      authRefresh: "refreshed",
      profiles: [],
    });

    const result = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );

    expect(result?.reply?.text).toBe(
      "OpenAI login completed, but this session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
    );
  });

  it("rejects empty profile identifiers returned by login", async () => {
    runModelsAuthLoginFlowMock.mockResolvedValue({
      providerId: "openai",
      methodId: "device-code",
      modelAccess: "already-visible",
      authRefresh: "refreshed",
      profiles: [{ profileId: " ", provider: "openai", mode: "oauth" }],
    });

    const result = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );

    expect(result?.reply?.text).toBe(
      "OpenAI login did not complete. Send `/login codex` to try again.",
    );
  });

  it("normalizes returned login identifiers before switching profiles", async () => {
    runModelsAuthLoginFlowMock.mockResolvedValue({
      providerId: " openai ",
      methodId: " device-code ",
      defaultModel: " openai/gpt-5.4 ",
      modelAccess: " enabled ",
      authRefresh: " refreshed ",
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

    expect(result?.reply?.text).toBe(
      "OpenAI login complete. Available OpenAI models will update automatically. Your default model is unchanged. Use /models to browse.",
    );
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

  it("does not pin the new profile when the current model uses another provider", async () => {
    mockSuccessfulLoginFlow();

    const params = buildLoginParams("/login codex", {
      opts: blockReplyOpts(),
      provider: "anthropic",
      sessionEntry: {
        authProfileOverride: "anthropic:owner@example.com",
        sessionId: "sess-owner",
        updatedAt: 1,
      },
    });
    await handleLoginCommand(params, true);

    expect(runModelsAuthLoginFlowMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        profileId: expect.any(String),
      }),
    );
    expect(params.sessionEntry?.authProfileOverride).toBe("anthropic:owner@example.com");
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
      "OpenAI login completed, but this session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
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
      "OpenAI login completed, but this session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
    );
    expect(params.sessionEntry).toBe(previousEntry);
    expect(sessionStore["agent:main:slack:channel:C123"]).toBe(previousEntry);
  });

  it("does not pin the login profile after the session switches providers", async () => {
    mockSuccessfulLoginFlow("openai:new-owner@example.com");
    const previousEntry = {
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      authProfileOverride: "openai:old-owner@example.com",
      authProfileOverrideSource: "user" as const,
      sessionId: "sess-owner",
      updatedAt: 1,
    };
    const switchedEntry = {
      ...previousEntry,
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      updatedAt: 2,
    };
    updateSessionEntryMock.mockImplementationOnce(
      async (params: { update: (entry: SessionEntry) => Partial<SessionEntry> | null }) => {
        const patch = params.update({ ...switchedEntry });
        return patch ? { ...switchedEntry, ...patch } : switchedEntry;
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
      "OpenAI login complete. Available OpenAI models will update automatically. Your default model is unchanged. Use /models to browse.",
    );
    expect(params.sessionEntry).toBe(switchedEntry);
    expect(params.sessionEntry?.authProfileOverride).toBe("openai:old-owner@example.com");
    expect(params.sessionEntry?.providerOverride).toBe("anthropic");
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
      "OpenAI login completed, but this session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.",
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
              modelAccess: "already-visible",
              authRefresh: "refreshed",
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
        text: "OpenAI login is already active for this chat or channel. Complete it, or wait for it to expire before requesting a new one.",
      },
    });
    resolveLogin();
    await first;
  });

  it("cancels an expired flow before replacing its reservation", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let firstSignal: AbortSignal | undefined;
    runModelsAuthLoginFlowMock
      .mockImplementationOnce(async (opts: ModelsAuthLoginFlowOptions) => {
        firstSignal = opts.signal;
        if (!firstSignal) {
          throw new Error("expected reservation signal");
        }
        const signal = firstSignal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error ? signal.reason : new Error("Codex login cancelled"),
              ),
            { once: true },
          );
        });
        throw new Error("unreachable");
      })
      .mockResolvedValueOnce({
        providerId: "openai",
        methodId: "device-code",
        modelAccess: "already-visible",
        authRefresh: "refreshed",
        profiles: [],
      });

    const first = handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    now.mockReturnValue(15 * 60_000 + 1_001);

    const second = await handleLoginCommand(
      buildLoginParams("/login codex", { opts: blockReplyOpts() }),
      true,
    );

    expect(firstSignal?.aborted).toBe(true);
    await expect(first).resolves.toEqual({
      shouldContinue: false,
      reply: {
        text: "OpenAI login did not complete. Send `/login codex` to try again.",
      },
    });
    expect(second?.reply?.text).toContain("could not switch");
    now.mockRestore();
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
        text: "Only a configured OpenClaw owner/admin can start provider login from this channel.",
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
        text: "Only a configured OpenClaw owner/admin can start provider login from this channel.",
      },
    });
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });

  it("returns a friendly error for unsupported providers", async () => {
    const result = await handleLoginCommand(
      buildLoginParams("/login definitely-unsupported"),
      true,
    );

    const text = result?.reply?.text ?? "";
    expect(result?.shouldContinue).toBe(false);
    expect(text).toMatch(/^Unsupported login provider\. Available provider access commands:/u);
    for (const command of [
      "/login codex",
      "/login xai",
      "/login minimax-global-oauth",
      "/login minimax-cn-oauth",
    ]) {
      expect(text).toContain(command);
    }
    expect(text).toContain("more in Control UI → Models");
    expect(text.length).toBeLessThan(1_000);
    expect(runModelsAuthLoginFlowMock).not.toHaveBeenCalled();
  });
});
