// Imported by dispatch-from-config.test.ts to keep its mocked suite in one Vitest module graph.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  createDispatcher,
  diagnosticMocks,
  emptyConfig,
  hookMocks,
  messageAuditMocks,
  mocks,
  sessionBindingMocks,
  sessionStoreMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  automaticGroupReplyConfig,
  dispatchReplyFromConfig,
  setNoAbort,
  firstMockArg,
  dispatchTwiceWithFreshDispatchers,
  messageAuditEvents,
  globalBeforeAll0,
  describe0BeforeEach0,
} from "./dispatch-from-config.test-harness.js";
import { usesFullReplyRuntime, usesPublishedReplyRuntime } from "./reply-config-runtime-mode.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    describe0BeforeEach0();
  });
  afterEach(clearRuntimeConfigSnapshot);

  it("keeps unauthorized plugin-owned binding slash replies suppressed while routed to the bound plugin", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true, reply: { text: "do not leak slash reply" } },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-command-escape-denied",
      targetSessionKey: "plugin-binding:codex:abc123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
        detachHint: "/codex detach",
      },
    } satisfies SessionBindingRecord);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:1481858418548412579",
      To: "discord:channel:1481858418548412579",
      AccountId: "default",
      SenderId: "user-9",
      SenderUsername: "ada",
      ChatType: "channel",
      CommandSource: "text",
      CommandAuthorized: false,
      WasMentioned: false,
      CommandBody: "/codex detach",
      RawBody: "/codex detach",
      Body: "/codex detach",
      MessageSid: "msg-claim-plugin-command-denied",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-command-escape-denied");
    expect(hookMocks.runner.runInboundClaimForPluginOutcome).toHaveBeenCalledWith(
      "openclaw-codex-app-server",
      expect.objectContaining({ content: "/codex detach" }),
      expect.objectContaining({
        pluginBinding: expect.objectContaining({ bindingId: "binding-command-escape-denied" }),
      }),
    );
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers plugin-owned binding replies returned by the owning inbound claim hook", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "codex", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true, reply: { text: "Codex native reply" } },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-reply-1",
      targetSessionKey: "plugin-binding:codex:reply123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "codex",
        pluginRoot: "/plugins/codex",
      },
    } satisfies SessionBindingRecord);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "discord:channel:1481858418548412579",
      To: "discord:channel:1481858418548412579",
      AccountId: "default",
      SenderId: "user-9",
      SenderUsername: "ada",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "who are you",
      RawBody: "who are you",
      Body: "who are you",
      MessageSid: "msg-claim-plugin-reply",
      SessionKey: "agent:main:discord:channel:1481858418548412579",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "Codex native reply" });
    expect(
      getReplyPayloadMetadata(
        firstMockArg(
          dispatcher.sendFinalReply as ReturnType<typeof vi.fn>,
          "plugin reply",
        ) as ReplyPayload,
      )?.sourceReplyTranscriptMirror,
    ).toBeUndefined();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("persists Gateway plugin-bound turns and routed replies in the binding session", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) => hookName === "inbound_claim") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "codex", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true, reply: { text: "Codex bound reply" } },
    });
    const targetSessionKey = "plugin-binding:codex:history123";
    const targetSessionEntry = {
      sessionId: "bound-session-id",
      updatedAt: Date.now(),
    };
    sessionStoreMocks.currentEntry = {
      sessionId: "source-session-id",
      updatedAt: Date.now(),
    };
    sessionStoreMocks.entriesBySessionKey.set(targetSessionKey, targetSessionEntry);
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation((...args: unknown[]) => {
      const params = args[0] as { sessionKey: string };
      return (
        sessionStoreMocks.entriesBySessionKey.get(params.sessionKey) ??
        sessionStoreMocks.currentEntry
      );
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-history-1",
      targetSessionKey,
      targetKind: "session",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "user:U123",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "codex",
        pluginRoot: "/plugins/codex",
      },
    } satisfies SessionBindingRecord);
    const persistApproved = vi.fn(async () => ({
      appended: true,
      sessionFile: "sqlite:bound-session-id",
      sessionEntry: targetSessionEntry,
      messageId: "user-turn-1",
      message: { role: "user" as const, content: "continue", timestamp: Date.now() },
    }));
    const markBlocked = vi.fn();
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "openclaw",
        Surface: "openclaw",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U123",
        To: "user:U123",
        AccountId: "default",
        CommandAuthorized: true,
        BodyForAgent: "continue",
        RawBody: "continue",
        Body: "continue",
        MessageSid: "msg-plugin-history",
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: {
        userTurnTranscriptRecorder: {
          hasPersisted: () => false,
          markBlocked,
          persistApproved,
        } as never,
      },
      replyResolver,
    });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(persistApproved).toHaveBeenCalledWith({
      target: expect.objectContaining({
        sessionId: "bound-session-id",
        sessionKey: targetSessionKey,
        sessionEntry: targetSessionEntry,
      }),
      expectedSessionId: "bound-session-id",
      retryIfUnpersisted: true,
    });
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { text: "Codex bound reply" },
        sessionKey: targetSessionKey,
        policySessionKey: targetSessionKey,
      }),
    );
    const routedCall = firstMockArg(mocks.routeReply, "plugin binding route") as {
      payload: ReplyPayload;
    };
    expect(getReplyPayloadMetadata(routedCall.payload)?.sourceReplyTranscriptMirror).toMatchObject({
      agentId: "main",
      expectedSessionId: "bound-session-id",
      sessionKey: targetSessionKey,
    });
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();

    const rotatedTargetSessionEntry = {
      sessionId: "rotated-bound-session-id",
      updatedAt: Date.now(),
    };
    persistApproved.mockImplementationOnce(async () => {
      sessionStoreMocks.entriesBySessionKey.set(targetSessionKey, rotatedTargetSessionEntry);
      return undefined as never;
    });
    mocks.routeReply.mockClear();
    const rotatedDispatcher = createDispatcher();
    const rotatedResult = await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "openclaw",
        Surface: "openclaw",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U123",
        To: "user:U123",
        AccountId: "default",
        CommandAuthorized: true,
        BodyForAgent: "continue after reset",
        RawBody: "continue after reset",
        Body: "continue after reset",
        MessageSid: "msg-plugin-history-rotated",
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher: rotatedDispatcher,
      replyOptions: {
        userTurnTranscriptRecorder: {
          hasPersisted: () => false,
          markBlocked,
          persistApproved,
        } as never,
      },
      replyResolver,
    });

    expect(rotatedResult).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    const rotatedRoutedCall = firstMockArg(mocks.routeReply, "rotated plugin binding route") as {
      payload: ReplyPayload;
      sessionKey: string;
    };
    expect(rotatedRoutedCall.sessionKey).toBe(targetSessionKey);
    expect(rotatedRoutedCall.payload).toEqual({ text: "Codex bound reply" });
    expect(
      getReplyPayloadMetadata(rotatedRoutedCall.payload)?.sourceReplyTranscriptMirror,
    ).toMatchObject({
      expectedSessionId: "rotated-bound-session-id",
      sessionKey: targetSessionKey,
    });
    expect(markBlocked).not.toHaveBeenCalled();
    expect(rotatedDispatcher.sendFinalReply).not.toHaveBeenCalled();

    persistApproved.mockResolvedValueOnce(undefined as never);
    mocks.routeReply.mockClear();
    const blockedDispatcher = createDispatcher();
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "openclaw",
        Surface: "openclaw",
        OriginatingChannel: "slack",
        OriginatingTo: "user:U123",
        To: "user:U123",
        AccountId: "default",
        CommandAuthorized: true,
        BodyForAgent: "continue during second reset",
        RawBody: "continue during second reset",
        Body: "continue during second reset",
        MessageSid: "msg-plugin-history-blocked",
        SessionKey: "agent:main:main",
      }),
      cfg: emptyConfig,
      dispatcher: blockedDispatcher,
      replyOptions: {
        userTurnTranscriptRecorder: {
          hasPersisted: () => false,
          markBlocked,
          persistApproved,
        } as never,
      },
      replyResolver,
    });

    const blockedRoutedCall = firstMockArg(mocks.routeReply, "blocked plugin binding route") as {
      payload: ReplyPayload;
      sessionKey: string;
    };
    expect(blockedRoutedCall.sessionKey).toBe(targetSessionKey);
    expect(
      getReplyPayloadMetadata(blockedRoutedCall.payload)?.sourceReplyTranscriptMirror,
    ).toMatchObject({
      expectedSessionId: "rotated-bound-session-id",
      sessionKey: targetSessionKey,
      transcriptWriteBlocked: true,
    });
    expect(markBlocked).toHaveBeenCalledTimes(1);
    expect(blockedDispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("routes plugin-owned Discord DM bindings to the owning plugin before generic inbound claim broadcast", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "handled",
      result: { handled: true },
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-dm-1",
      targetSessionKey: "plugin-binding:codex:dm123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
    } satisfies SessionBindingRecord);
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      From: "discord:1177378744822943744",
      OriginatingTo: "channel:1480574946919846079",
      To: "channel:1480574946919846079",
      AccountId: "default",
      SenderId: "user-9",
      SenderUsername: "ada",
      CommandAuthorized: true,
      WasMentioned: false,
      CommandBody: "who are you",
      RawBody: "who are you",
      Body: "who are you",
      MessageSid: "msg-claim-plugin-dm-1",
      SessionKey: "agent:main:discord:user:1177378744822943744",
    });
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    const result = await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
    expect(sessionBindingMocks.touch).toHaveBeenCalledWith("binding-dm-1");
    const inboundClaimCall = hookMocks.runner.runInboundClaimForPluginOutcome.mock
      .calls[0] as unknown as
      | [
          unknown,
          { accountId?: unknown; channel?: unknown; content?: unknown; conversationId?: unknown },
          { accountId?: unknown; channelId?: unknown; conversationId?: unknown },
        ]
      | undefined;
    expect(inboundClaimCall?.[0]).toBe("openclaw-codex-app-server");
    expect(inboundClaimCall?.[1]?.channel).toBe("discord");
    expect(inboundClaimCall?.[1]?.accountId).toBe("default");
    expect(inboundClaimCall?.[1]?.conversationId).toBe("1480574946919846079");
    expect(inboundClaimCall?.[1]?.content).toBe("who are you");
    expect(inboundClaimCall?.[2]?.channelId).toBe("discord");
    expect(inboundClaimCall?.[2]?.accountId).toBe("default");
    expect(inboundClaimCall?.[2]?.conversationId).toBe("1480574946919846079");
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(replyResolver).not.toHaveBeenCalled();
  });

  it("falls back to OpenClaw once per startup when a bound plugin is missing", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "missing_plugin",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-missing-1",
      targetSessionKey: "plugin-binding:codex:missing123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:missing-plugin",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
        detachHint: "/codex_detach",
      },
    } satisfies SessionBindingRecord);

    const replyResolver = vi.fn(async () => ({ text: "openclaw fallback" }) satisfies ReplyPayload);

    const firstDispatcher = createDispatcher();
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:missing-plugin",
        To: "discord:channel:missing-plugin",
        AccountId: "default",
        MessageSid: "msg-missing-plugin-1",
        SessionKey: "agent:main:discord:channel:missing-plugin",
        CommandBody: "hello",
        RawBody: "hello",
        Body: "hello",
      }),
      cfg: emptyConfig,
      dispatcher: firstDispatcher,
      replyResolver,
    });

    const firstNotice = (firstDispatcher.sendToolResult as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(firstNotice?.text).toContain("is not currently loaded.");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();

    replyResolver.mockClear();
    hookMocks.runner.runInboundClaim.mockClear();

    const secondDispatcher = createDispatcher();
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:missing-plugin",
        To: "discord:channel:missing-plugin",
        AccountId: "default",
        MessageSid: "msg-missing-plugin-2",
        SessionKey: "agent:main:discord:channel:missing-plugin",
        CommandBody: "still there?",
        RawBody: "still there?",
        Body: "still there?",
      }),
      cfg: emptyConfig,
      dispatcher: secondDispatcher,
      replyResolver,
    });

    expect(secondDispatcher.sendToolResult).not.toHaveBeenCalled();
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("falls back to OpenClaw when the bound plugin is loaded but has no inbound_claim handler", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "no_handler",
    });
    hookMocks.runner.runInboundClaimForPluginOutcome.mockClear();
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-no-handler-1",
      targetSessionKey: "plugin-binding:codex:nohandler123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:no-handler",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
    } satisfies SessionBindingRecord);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "openclaw fallback" }) satisfies ReplyPayload);

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:no-handler",
        To: "discord:channel:no-handler",
        AccountId: "default",
        MessageSid: "msg-no-handler-1",
        SessionKey: "agent:main:discord:channel:no-handler",
        CommandBody: "hello",
        RawBody: "hello",
        Body: "hello",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    const notice = firstMockArg(
      dispatcher.sendToolResult as ReturnType<typeof vi.fn>,
      "tool result",
    ) as ReplyPayload | undefined;
    expect(notice?.text).toContain("is not currently loaded.");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("notifies the user when a bound plugin declines the turn and keeps the binding attached", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "declined",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-declined-1",
      targetSessionKey: "plugin-binding:codex:declined123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:declined",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
        detachHint: "/codex_detach",
      },
    } satisfies SessionBindingRecord);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:declined",
        To: "discord:channel:declined",
        AccountId: "default",
        MessageSid: "msg-declined-1",
        SessionKey: "agent:main:discord:channel:declined",
        CommandBody: "hello",
        RawBody: "hello",
        Body: "hello",
      }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    const finalNotice = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalNotice?.text).toContain("Plugin binding request was declined.");
    expect(replyResolver).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
  });

  it("notifies the user when a bound plugin errors and keeps raw details out of the reply", async () => {
    setNoAbort();
    hookMocks.runner.hasHooks.mockImplementation(
      ((hookName?: string) =>
        hookName === "inbound_claim" || hookName === "message_received") as () => boolean,
    );
    hookMocks.registry.plugins = [{ id: "openclaw-codex-app-server", status: "loaded" }];
    hookMocks.runner.runInboundClaimForPluginOutcome.mockResolvedValue({
      status: "error",
      error: "boom",
    });
    sessionBindingMocks.resolveByConversation.mockReturnValue({
      bindingId: "binding-error-1",
      targetSessionKey: "plugin-binding:codex:error123",
      targetKind: "session",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:error",
      },
      status: "active",
      boundAt: 1710000000000,
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "openclaw-codex-app-server",
        pluginName: "Codex App Server",
        pluginRoot: "/Users/huntharo/github/openclaw-app-server",
      },
    } satisfies SessionBindingRecord);
    const dispatcher = createDispatcher();
    const replyResolver = vi.fn(async () => ({ text: "should not run" }) satisfies ReplyPayload);

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        OriginatingTo: "discord:channel:error",
        To: "discord:channel:error",
        AccountId: "default",
        MessageSid: "msg-error-1",
        SessionKey: "agent:main:discord:channel:error",
        CommandBody: "hello",
        RawBody: "hello",
        Body: "hello",
      }),
      cfg: { diagnostics: { enabled: true } } as OpenClawConfig,
      dispatcher,
      replyResolver,
    });

    const finalNotice = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalNotice?.text).toContain("Plugin binding request failed.");
    expect(finalNotice?.text).not.toContain("boom");
    expect(replyResolver).not.toHaveBeenCalled();
    expect(hookMocks.runner.runInboundClaim).not.toHaveBeenCalled();
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledOnce();
    expect(messageAuditEvents()[0]).toEqual(
      expect.objectContaining({
        status: "failed",
        outcome: "failed",
        errorCode: "message_processing_failed",
        reasonCode: "plugin_bound_error",
      }),
    );
    expect(messageAuditEvents()[0]).not.toHaveProperty("error");
    expect(JSON.stringify(messageAuditEvents()[0])).not.toContain("boom");
    const diagnosticEvent = diagnosticMocks.logMessageProcessed.mock.calls
      .map(([event]) => event as { outcome?: unknown; reason?: unknown })
      .find((event) => event.reason === "plugin-bound-error");
    expect(diagnosticEvent?.outcome).toBe("completed");
  });

  it("marks diagnostics skipped for duplicate inbound messages", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      AccountId: "default",
      MessageSid: "msg-dup",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchTwiceWithFreshDispatchers({
      ctx,
      cfg,
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
    const skippedEvent = diagnosticMocks.logMessageProcessed.mock.calls
      .map(([event]) => event as { channel?: unknown; outcome?: unknown; reason?: unknown })
      .find((event) => event.outcome === "skipped");
    expect(skippedEvent?.channel).toBe("whatsapp");
    expect(skippedEvent?.reason).toBe("duplicate");
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledTimes(2);
    const skippedAuditEvent = messageAuditEvents().find((event) => event.outcome === "skipped");
    expect(skippedAuditEvent).toEqual(
      expect.objectContaining({
        action: "message.inbound.processed",
        status: "blocked",
        actorType: "system",
        actorId: "gateway",
        direction: "inbound",
        channel: "whatsapp",
        outcome: "skipped",
        reasonCode: "duplicate",
      }),
    );
    expect(skippedAuditEvent).not.toHaveProperty("reason");
  });

  it("keeps duplicate skip diagnostics inside the active inbound trace", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      AccountId: "default",
      MessageSid: "msg-dup-trace",
    });
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);
    const inboundTrace = createDiagnosticTraceContext();
    const processedTraces: Array<{
      outcome?: unknown;
      reason?: unknown;
      traceId?: string;
      spanId?: string;
    }> = [];

    diagnosticMocks.logMessageProcessed.mockImplementation((event) => {
      const activeTrace = getActiveDiagnosticTraceContext();
      processedTraces.push({
        outcome: event.outcome,
        reason: event.reason,
        traceId: activeTrace?.traceId,
        spanId: activeTrace?.spanId,
      });
    });

    try {
      await runWithDiagnosticTraceContext(inboundTrace, () =>
        dispatchTwiceWithFreshDispatchers({
          ctx,
          cfg,
          replyResolver,
        }),
      );
    } finally {
      diagnosticMocks.logMessageProcessed.mockReset();
    }

    const skippedEvent = processedTraces.find((event) => event.outcome === "skipped");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(skippedEvent?.reason).toBe("duplicate");
    expect(skippedEvent?.traceId).toBe(inboundTrace.traceId);
    expect(skippedEvent?.spanId).toBe(inboundTrace.spanId);
  });

  it("releases inbound dedupe when dispatch fails before completion", async () => {
    setNoAbort();
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550124",
      To: "whatsapp:+15555550124",
      AccountId: "default",
      MessageSid: "msg-dup-error",
      SessionKey: "agent:main:whatsapp:direct:+15555550124",
      CommandBody: "hello",
      RawBody: "hello",
      Body: "hello",
    });
    const replyResolver = vi
      .fn<
        (_ctx: MsgContext, _opts?: GetReplyOptions, _cfg?: OpenClawConfig) => Promise<ReplyPayload>
      >()
      .mockRejectedValueOnce(new Error("dispatch failed"))
      .mockResolvedValueOnce({ text: "retry succeeds" });

    await expect(
      dispatchReplyFromConfig({
        ctx,
        cfg,
        dispatcher: createDispatcher(),
        replyResolver,
      }),
    ).rejects.toThrow("dispatch failed");

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(2);
    const errorEvent = diagnosticMocks.logMessageProcessed.mock.calls
      .map(([event]) => event as { channel?: unknown; error?: unknown; outcome?: unknown })
      .find((event) => event.outcome === "error");
    expect(errorEvent?.channel).toBe("whatsapp");
    expect(errorEvent?.error).toBe("Error: dispatch failed");
    expect(messageAuditMocks.emitTrustedMessageAuditEvent).toHaveBeenCalledTimes(2);
    const failedAuditEvent = messageAuditEvents().find((event) => event.outcome === "failed");
    expect(failedAuditEvent).toEqual(
      expect.objectContaining({
        action: "message.inbound.processed",
        status: "failed",
        direction: "inbound",
        channel: "whatsapp",
        outcome: "failed",
        errorCode: "message_processing_failed",
      }),
    );
    expect(failedAuditEvent).not.toHaveProperty("error");
    expect(JSON.stringify(failedAuditEvent)).not.toContain("dispatch failed");
  });

  it.each([
    {
      name: "poisons inbound dedupe when dispatch fails after a block reply",
      phone: "+15555550125",
      messageSid: "msg-dup-block-error",
      kind: "block",
      text: "partial answer",
      error: "provider failed after block",
    },
    {
      name: "poisons inbound dedupe when dispatch fails after a suppressed tool result",
      phone: "+15555550126",
      messageSid: "msg-dup-tool-error",
      kind: "tool",
      text: "tool touched external state",
      error: "provider failed after tool",
    },
  ] as const)("$name", async ({ phone, messageSid, kind, text, error }) => {
    setNoAbort();
    if (kind === "tool") {
      sessionStoreMocks.currentEntry = { sessionId: "s1", updatedAt: 0, sendPolicy: "deny" };
    }
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: `whatsapp:${phone}`,
      To: `whatsapp:${phone}`,
      AccountId: "default",
      MessageSid: messageSid,
      SessionKey: `agent:main:whatsapp:direct:${phone}`,
      CommandBody: "hello",
      RawBody: "hello",
      Body: "hello",
    });
    const firstDispatcher = createDispatcher();
    const replyResolver = vi.fn(
      async (_ctx: MsgContext, opts?: GetReplyOptions): Promise<ReplyPayload | undefined> => {
        if (kind === "block") {
          await opts?.onBlockReply?.({ text });
        } else {
          await opts?.onToolResult?.({ text });
        }
        throw new Error(error);
      },
    );

    await expect(
      dispatchReplyFromConfig({
        ctx,
        cfg: emptyConfig,
        dispatcher: firstDispatcher,
        replyResolver,
      }),
    ).rejects.toThrow(error);
    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    if (kind === "block") {
      expect(firstDispatcher.sendBlockReply).toHaveBeenCalledWith({ text });
    } else {
      expect(firstDispatcher.sendToolResult).not.toHaveBeenCalled();
    }
    expect(replyResolver).toHaveBeenCalledTimes(1);
  });

  it("applies configOverride as a patch over the runtime config for replyResolver", async () => {
    setNoAbort();
    const cfg = emptyConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "msteams", Surface: "msteams" });
    setRuntimeConfigSnapshot({
      agents: { defaults: { userTimezone: "UTC" } },
      messages: { suppressToolErrors: true },
    });

    const overrideCfg = {
      agents: { defaults: { userTimezone: "America/New_York" } },
    } as OpenClawConfig;

    let receivedCfg: OpenClawConfig | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      cfgArg?: OpenClawConfig,
    ) => {
      receivedCfg = cfgArg;
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      configOverride: overrideCfg,
    });

    expect(receivedCfg).not.toBe(cfg);
    expect(receivedCfg).not.toBe(overrideCfg);
    expect(receivedCfg).toMatchObject({
      agents: { defaults: { userTimezone: "America/New_York" } },
      messages: { suppressToolErrors: true },
    });
  });

  it("keeps the caller config exact before a runtime snapshot is published", async () => {
    setNoAbort();
    const cfg = {
      agents: { defaults: { userTimezone: "America/Los_Angeles" } },
    } as OpenClawConfig;
    let receivedCfg: OpenClawConfig | undefined;

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "discord", Surface: "discord" }),
      cfg,
      dispatcher: createDispatcher(),
      replyResolver: async (_ctx, _opts, cfgArg) => {
        receivedCfg = cfgArg;
        return { text: "hi" };
      },
    });

    expect(receivedCfg).toBe(cfg);
    expect(usesFullReplyRuntime(receivedCfg)).toBe(true);
    expect(usesPublishedReplyRuntime(receivedCfg)).toBe(false);
  });

  it("marks the committed runtime snapshot for published-owner reply resolution", async () => {
    setNoAbort();
    const runtimeCfg = {
      agents: { defaults: { userTimezone: "America/New_York" } },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeCfg);
    let receivedCfg: OpenClawConfig | undefined;

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "discord", Surface: "discord" }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver: async (_ctx, _opts, cfgArg) => {
        receivedCfg = cfgArg;
        return { text: "hi" };
      },
    });

    expect(receivedCfg).toBe(runtimeCfg);
    expect(usesPublishedReplyRuntime(receivedCfg)).toBe(true);
  });

  it("marks a channel-captured config for published-owner resolution before a snapshot exists", async () => {
    setNoAbort();
    const cfg = {
      agents: { defaults: { userTimezone: "America/Los_Angeles" } },
    } as OpenClawConfig;
    let receivedCfg: OpenClawConfig | undefined;

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "slack", Surface: "slack" }),
      cfg,
      dispatcher: createDispatcher(),
      usePublishedModelRuntime: true,
      replyResolver: async (_ctx, _opts, cfgArg) => {
        receivedCfg = cfgArg;
        return { text: "hi" };
      },
    });

    expect(receivedCfg).toBe(cfg);
    expect(usesPublishedReplyRuntime(receivedCfg)).toBe(true);
  });

  it("drops a removed Firecrawl SecretRef from Discord replies after config reload", async () => {
    setNoAbort();
    const cfg = {
      plugins: {
        entries: {
          firecrawl: {
            config: {
              webFetch: {
                apiKey: {
                  source: "file",
                  provider: "default",
                  id: "/firecrawl/api-key",
                },
              },
            },
          },
        },
      },
    } as OpenClawConfig;
    const runtimeCfg = {
      agents: { defaults: { userTimezone: "America/Edmonton" } },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeCfg);
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "discord", Surface: "discord" });

    let receivedCfg: OpenClawConfig | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      _opts?: GetReplyOptions,
      cfgArg?: OpenClawConfig,
    ) => {
      receivedCfg = cfgArg;
      if (cfgArg?.plugins?.entries?.firecrawl) {
        throw new Error("stale Firecrawl SecretRef reached reply resolution");
      }
      return { text: "hi" } satisfies ReplyPayload;
    };

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(receivedCfg).toBe(runtimeCfg);
    expect(receivedCfg?.plugins?.entries?.firecrawl).toBeUndefined();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "hi" });
  });

  it.each([
    [
      "suppresses isReasoning payloads from final replies (WhatsApp channel)",
      "whatsapp",
      "reasoning",
      "final",
      false,
    ],
    [
      "delivers isReasoning final replies when the channel opts in",
      "telegram",
      "reasoning",
      "final",
      true,
    ],
    [
      "suppresses isCommentary payloads from final replies by default",
      "whatsapp",
      "commentary",
      "final",
      false,
    ],
    [
      "delivers isCommentary final replies when the channel opts in",
      "discord",
      "commentary",
      "final",
      true,
    ],
    [
      "does not synthesize opted-in final reasoning payloads into TTS media",
      "telegram",
      "reasoning",
      "final-tts",
      true,
    ],
    [
      "does not synthesize opted-in final commentary payloads into TTS media",
      "discord",
      "commentary",
      "final-tts",
      true,
    ],
    [
      "suppresses isReasoning payloads from block replies (generic dispatch path)",
      "whatsapp",
      "reasoning",
      "block",
      false,
    ],
    [
      "delivers opted-in block reasoning payloads without applying TTS",
      "telegram",
      "reasoning",
      "block",
      true,
    ],
    [
      "suppresses isCommentary payloads from block replies by default",
      "whatsapp",
      "commentary",
      "block",
      false,
    ],
    [
      "delivers opted-in block commentary payloads without applying TTS",
      "discord",
      "commentary",
      "block",
      true,
    ],
  ] as const)("%s", async (_name, provider, kind, delivery, enabled) => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = delivery === "final-tts";
    const dispatcher = createDispatcher();
    const progressPayload =
      kind === "reasoning"
        ? ({ text: "thinking...", isReasoning: true } satisfies ReplyPayload)
        : ({ text: "commentary...", isCommentary: true } satisfies ReplyPayload);
    const answer = { text: "The answer is 42" } satisfies ReplyPayload;
    const replyOptions =
      kind === "reasoning"
        ? { reasoningPayloadsEnabled: true }
        : { commentaryPayloadsEnabled: true };
    const replyResolver = async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      if (delivery === "block") {
        await opts?.onBlockReply?.(progressPayload);
        await opts?.onBlockReply?.(answer);
        return enabled ? undefined : answer;
      }
      return delivery === "final-tts" ? progressPayload : [progressPayload, answer];
    };

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: provider, Surface: provider }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: enabled ? replyOptions : undefined,
      replyResolver,
    });

    if (delivery === "block") {
      const blockCalls = vi.mocked(dispatcher.sendBlockReply).mock.calls;
      const delivered = blockCalls.map(([payload]) => payload.text);
      expect(delivered).toEqual(enabled ? [progressPayload.text, answer.text] : [answer.text]);
      if (enabled) {
        const blockTts = ttsMocks.maybeApplyTtsToPayload.mock.calls
          .map(([call]) => call as { kind?: unknown; payload?: ReplyPayload })
          .filter((call) => call.kind === "block");
        expect(blockTts.map((call) => call.payload?.text)).toEqual([answer.text]);
      }
    } else if (delivery === "final-tts") {
      expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
      expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(progressPayload);
    } else {
      const finalCalls = vi.mocked(dispatcher.sendFinalReply).mock.calls;
      const delivered = finalCalls.map(([payload]) => payload.text);
      expect(delivered).toEqual(enabled ? [progressPayload.text, answer.text] : [answer.text]);
    }
  });

  it("does not redeliver a final that already settled as an identical block", async () => {
    setNoAbort();
    const delivered: Array<{ kind: string; text?: string }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        delivered.push({ kind: info.kind, text: payload.text });
      },
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "rewritten command answer" });
      return { text: "rewritten command answer" };
    };

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([{ kind: "block", text: "rewritten command answer" }]);
    expect(result.counts).toEqual({ tool: 0, block: 1, final: 0 });
  });

  it("keeps the final fallback when an identical block delivery fails", async () => {
    setNoAbort();
    const delivered: Array<{ kind: string; text?: string }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        if (info.kind === "block") {
          throw new Error("block delivery failed");
        }
        delivered.push({ kind: info.kind, text: payload.text });
      },
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "retry this final" });
      return { text: "retry this final" };
    };

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([{ kind: "final", text: "retry this final" }]);
    expect(result.counts).toEqual({ tool: 0, block: 1, final: 1 });
  });

  it("does not send the final fallback when aborted during block settlement", async () => {
    setNoAbort();
    let markBlockStarted: (() => void) | undefined;
    let releaseBlock: (() => void) | undefined;
    const blockStarted = new Promise<void>((resolve) => {
      markBlockStarted = resolve;
    });
    const blockRelease = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
    const delivered: Array<{ kind: string; text?: string }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        if (info.kind === "block") {
          markBlockStarted?.();
          await blockRelease;
          throw new Error("block delivery failed after abort");
        }
        delivered.push({ kind: info.kind, text: payload.text });
      },
    });
    const abortController = new AbortController();
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "cancelled rewritten answer" });
      return { text: "cancelled rewritten answer" };
    };

    const dispatch = dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyOptions: { abortSignal: abortController.signal },
      replyResolver,
    });
    await blockStarted;
    abortController.abort();
    await dispatch;
    expect(delivered).toEqual([]);

    releaseBlock?.();
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([]);
  });

  it("keeps final-only TTS media after deduping identical block text", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const delivered: Array<{ kind: string; payload: ReplyPayload }> = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        delivered.push({ kind: info.kind, payload });
      },
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "spoken rewritten answer" });
      return { text: "spoken rewritten answer" };
    };

    const result = await dispatchReplyFromConfig({
      ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([
      { kind: "block", payload: { text: "spoken rewritten answer" } },
      {
        kind: "final",
        payload: expect.objectContaining({
          text: undefined,
          mediaUrl: "https://example.com/tts-synth.opus",
          audioAsVoice: true,
        }),
      },
    ]);
    expect(result.counts).toEqual({ tool: 0, block: 1, final: 1 });
  });

  it("strips split TTS directives from streamed block text before delivery", async () => {
    setNoAbort();
    ttsMocks.state.synthesizeFinalAudio = true;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const blockReplySentTexts: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "Intro [[tts:te" });
      await opts?.onBlockReply?.({ text: "xt]]hidden[[/tts:text]] visible" });
      return undefined;
    };
    (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: ReplyPayload) => {
        if (payload.text) {
          blockReplySentTexts.push(payload.text);
        }
        return true;
      },
    );

    await dispatchReplyFromConfig({ ctx, cfg: emptyConfig, dispatcher, replyResolver });

    expect(blockReplySentTexts).toEqual(["Intro ", " visible"]);
    expect(blockReplySentTexts.join("")).not.toContain("[[tts");
    expect(blockReplySentTexts.join("")).not.toContain("hidden");
    const ttsCall = ttsMocks.maybeApplyTtsToPayload.mock.calls
      .map(([call]) => call as { kind?: unknown; payload?: ReplyPayload })
      .find((call) => call.kind === "final");
    expect(ttsCall?.kind).toBe("final");
    expect(ttsCall?.payload).toEqual({ text: "Intro [[tts:text]]hidden[[/tts:text]] visible" });
    const finalPayload = (dispatcher.sendFinalReply as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ReplyPayload | undefined;
    expect(finalPayload?.mediaUrl).toBe("https://example.com/tts-synth.opus");
  });

  it("forwards generated-media block replies in WhatsApp group sessions", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "whatsapp",
      Surface: "whatsapp",
      ChatType: "group",
      From: "whatsapp:120363111111111@g.us",
      To: "whatsapp:120363111111111@g.us",
      SessionKey: "agent:main:whatsapp:group:120363111111111@g.us",
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({
        text: "generated",
        mediaUrls: ["https://example.com/generated.png"],
      });
      return { text: "NO_REPLY" };
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: automaticGroupReplyConfig,
      dispatcher,
      replyResolver,
    });

    expect(dispatcher.sendBlockReply).toHaveBeenCalledTimes(1);
    expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({
      text: "generated",
      mediaUrls: ["https://example.com/generated.png"],
    });
  });

  it("signals block boundaries before async block delivery is queued", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const callOrder: string[] = [];
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "The answer is 42" });
      return undefined;
    };

    (dispatcher.sendBlockReply as ReturnType<typeof vi.fn>).mockImplementation(
      (payload: ReplyPayload) => {
        callOrder.push(`dispatch:${payload.text}`);
        return true;
      },
    );

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: {
        onBlockReplyQueued: (payload) => {
          callOrder.push(`queued:${payload.text}`);
        },
      },
    });

    expect(callOrder).toEqual(["queued:The answer is 42", "dispatch:The answer is 42"]);
  });

  it("does not wait for same-channel block dispatcher delivery before resolving block replies", async () => {
    setNoAbort();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const delivered: ReplyPayload[] = [];
    let releaseDelivery: (() => void) | undefined;
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        markDeliveryStarted?.();
        await deliveryGate;
      },
    });
    let blockReplySettled = false;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      const blockReplyPromise = Promise.resolve(opts?.onBlockReply?.({ text: "before tool" })).then(
        () => {
          blockReplySettled = true;
        },
      );

      await deliveryStarted;

      expect(delivered).toEqual([{ text: "before tool" }]);
      await blockReplyPromise;
      expect(blockReplySettled).toBe(true);

      releaseDelivery?.();
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    });

    expect(blockReplySettled).toBe(true);
    await dispatcher.waitForIdle();
  });

  it("waits for pending same-channel block delivery before completing block-only dispatch", async () => {
    setNoAbort();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const delivered: ReplyPayload[] = [];
    let releaseDelivery: (() => void) | undefined;
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        markDeliveryStarted?.();
        await deliveryGate;
      },
    });
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "only block" });
      return undefined;
    };

    let dispatchSettled = false;
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
    }).then((result) => {
      dispatchSettled = true;
      return result;
    });

    await deliveryStarted;

    expect(delivered).toEqual([{ text: "only block" }]);
    expect(dispatchSettled).toBe(false);

    releaseDelivery?.();
    await dispatchPromise;

    expect(dispatchSettled).toBe(true);
  });

  it("waits for pending same-channel block delivery before forwarding tool progress", async () => {
    setNoAbort();
    const cfg = {
      agents: { defaults: { verboseDefault: "on" } },
    } as const satisfies OpenClawConfig;
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const delivered: ReplyPayload[] = [];
    let releaseDelivery: (() => void) | undefined;
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const progressOrder: string[] = [];
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        if (payload.text === "final") {
          progressOrder.push("final");
        }
        markDeliveryStarted?.();
        await deliveryGate;
      },
    });
    const onToolStart = vi.fn();
    onToolStart.mockImplementation(() => {
      progressOrder.push("tool");
    });
    const onPartialReply = vi.fn(() => {
      progressOrder.push("partial");
    });
    let toolProgressSettled = false;
    let toolProgressPromise: Promise<void> | undefined;
    let partialProgressPromise: Promise<void> | undefined;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload> => {
      await opts?.onBlockReply?.({ text: "before tool" });
      toolProgressPromise = Promise.resolve(opts?.onToolStart?.({ name: "lookup" })).then(() => {
        toolProgressSettled = true;
      });
      partialProgressPromise = Promise.resolve(opts?.onPartialReply?.({ text: "after tool" }));
      return { text: "final" };
    };

    let dispatchSettled = false;
    const dispatchPromise = dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: {
        preserveProgressCallbackStartOrder: true,
        onPartialReply,
        onToolStart,
      },
    }).then((result) => {
      dispatchSettled = true;
      return result;
    });

    await deliveryStarted;
    expect(delivered).toEqual([{ text: "before tool" }]);
    expect(onToolStart).not.toHaveBeenCalled();
    expect(onPartialReply).not.toHaveBeenCalled();
    expect(toolProgressSettled).toBe(false);
    expect(dispatchSettled).toBe(false);

    releaseDelivery?.();
    await Promise.all([dispatchPromise, toolProgressPromise, partialProgressPromise]);

    expect(dispatchSettled).toBe(true);
    expect(toolProgressSettled).toBe(true);
    expect(onToolStart).toHaveBeenCalledWith({ name: "lookup" });
    expect(onPartialReply).toHaveBeenCalledWith({ text: "after tool" });
    expect(progressOrder).toEqual(["tool", "partial", "final"]);
    expect(delivered).toEqual([{ text: "before tool" }, { text: "final" }]);
  });

  it("does not synthesize tool-start capability while ordering item progress", async () => {
    setNoAbort();
    const cfg = {
      agents: { defaults: { verboseDefault: "on" } },
    } as const satisfies OpenClawConfig;
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const delivered: ReplyPayload[] = [];
    let releaseDelivery: (() => void) | undefined;
    let markDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload);
        markDeliveryStarted?.();
        await deliveryGate;
      },
    });
    const onItemEvent = vi.fn();
    let itemProgressSettled = false;
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      await opts?.onBlockReply?.({ text: "before item" });
      expect(opts?.onToolStart).toBeUndefined();
      const itemProgressPromise = Promise.resolve(
        opts?.onItemEvent?.({ itemId: "1", kind: "tool", progressText: "running" }),
      ).then(() => {
        itemProgressSettled = true;
      });

      await deliveryStarted;

      expect(delivered).toEqual([{ text: "before item" }]);
      expect(onItemEvent).not.toHaveBeenCalled();
      expect(itemProgressSettled).toBe(false);

      releaseDelivery?.();
      await itemProgressPromise;
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver,
      replyOptions: { onItemEvent },
    });

    expect(itemProgressSettled).toBe(true);
    expect(onItemEvent).toHaveBeenCalledWith({
      itemId: "1",
      kind: "tool",
      progressText: "running",
    });
  });

  it("forwards payload metadata into onBlockReplyQueued context", async () => {
    setNoAbort();
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({ Provider: "whatsapp" });
    const onBlockReplyQueued = vi.fn();
    const replyResolver = async (
      _ctx: MsgContext,
      opts?: GetReplyOptions,
    ): Promise<ReplyPayload | undefined> => {
      const payload = setReplyPayloadMetadata({ text: "Alpha" }, { assistantMessageIndex: 7 });
      await opts?.onBlockReply?.(payload);
      return undefined;
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher,
      replyResolver,
      replyOptions: { onBlockReplyQueued },
    });

    expect(onBlockReplyQueued).toHaveBeenCalledWith(
      { text: "Alpha" },
      { assistantMessageIndex: 7 },
    );
    const queuedPayload = onBlockReplyQueued.mock.calls[0]?.[0];
    expect(queuedPayload ? getReplyPayloadMetadata(queuedPayload) : undefined).toMatchObject({
      assistantMessageIndex: 7,
    });
    const deliveredPayload = vi.mocked(dispatcher.sendBlockReply).mock.calls[0]?.[0];
    expect(deliveredPayload ? getReplyPayloadMetadata(deliveredPayload) : undefined).toMatchObject({
      assistantMessageIndex: 7,
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
