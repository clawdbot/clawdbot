/**
 * Tests direct-message guard policy helpers exposed through the SDK.
 */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveImplicitMessageActionTarget } from "../infra/outbound/message-action-normalization.js";
import {
  createDirectDmPreCryptoGuardPolicy,
  createPreCryptoDirectDmAuthorizer,
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
} from "./channel-inbound.js";
import { resolveStableChannelMessageIngress } from "./channel-ingress-runtime.js";

const baseCfg = {
  commands: { useAccessGroups: true },
} as unknown as OpenClawConfig;

function createDirectDmRuntime() {
  const recordInboundSessionMock = vi.fn(async (_params: unknown) => {});
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "reply text" });
  });
  const runInbound = vi.fn(async ({ adapter, raw }) => {
    const input = await adapter.ingest(raw);
    const turn = await adapter.resolveTurn(input, {
      kind: "message",
      canStartAgentTurn: true,
    });
    await recordInboundSessionMock({
      storePath: "/tmp/direct-dm-session-store",
      sessionKey: turn.route.sessionKey,
      ctx: turn.ctxPayload,
      onRecordError: turn.record?.onRecordError ?? (() => undefined),
    });
    return {
      admission: { kind: "dispatch" },
      dispatched: true,
      dispatchResult: await dispatchReplyWithBufferedBlockDispatcher({
        ctx: turn.ctxPayload,
        cfg: turn.cfg,
        dispatcherOptions: {
          ...turn.dispatcherOptions,
          deliver: turn.delivery.deliver,
          onError: turn.delivery.onError,
        },
        replyOptions: turn.replyOptions,
      }),
    };
  });
  return {
    recordInboundSession: recordInboundSessionMock,
    dispatchReplyWithBufferedBlockDispatcher,
    runtime: {
      channel: {
        routing: {
          resolveAgentRoute: vi.fn(({ accountId, peer }) => ({
            agentId: "agent-main",
            accountId,
            sessionKey: `dm:${peer.id}`,
          })),
        },
        session: {
          resolveStorePath: vi.fn(() => "/tmp/direct-dm-session-store"),
          readSessionUpdatedAt: vi.fn(() => 1234),
          recordInboundSession: recordInboundSessionMock,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({ mode: "agent" })),
          formatAgentEnvelope: vi.fn(({ body }) => `env:${body}`),
          finalizeInboundContext: vi.fn((ctx) => ctx),
          dispatchReplyWithBufferedBlockDispatcher,
        },
        inbound: { run: runInbound },
      },
    } as never,
  };
}

describe("channel-inbound direct-message helpers", () => {
  it("resolves inbound DM access and command auth through one helper", async () => {
    const result = await resolveInboundDirectDmAccessWithRuntime({
      cfg: baseCfg,
      channel: "nostr",
      accountId: "default",
      dmPolicy: "pairing",
      allowFrom: [],
      senderId: "paired-user",
      rawBody: "/status",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      readStoreAllowFrom: async () => ["paired-user"],
      runtime: {
        shouldComputeCommandAuthorized: () => true,
        resolveCommandAuthorizedFromAuthorizers: ({ authorizers }) =>
          authorizers.some((entry) => entry.configured && entry.allowed),
      },
      modeWhenAccessGroupsOff: "configured",
    });

    expect(result.access.decision).toBe("allow");
    expect(result.access.effectiveAllowFrom).toEqual(["paired-user"]);
    expect(result.senderAllowedForCommands).toBe(true);
    expect(result.commandAuthorized).toBe(true);
  });

  it("blocks open DMs unless the effective allowlist matches", async () => {
    const result = await resolveInboundDirectDmAccessWithRuntime({
      cfg: baseCfg,
      channel: "nostr",
      accountId: "default",
      dmPolicy: "open",
      allowFrom: [],
      senderId: "random-user",
      rawBody: "hello",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      readStoreAllowFrom: async () => ["random-user"],
      runtime: {
        shouldComputeCommandAuthorized: () => false,
        resolveCommandAuthorizedFromAuthorizers: () => true,
      },
    });

    expect(result.access.decision).toBe("block");
    expect(result.access.reason).toBe("dmPolicy=open (not allowlisted)");
    expect(result.access.effectiveAllowFrom).toStrictEqual([]);
    expect(result.commandAuthorized).toBeUndefined();
  });

  it("resolves generic message sender access groups for direct DMs", async () => {
    const result = await resolveInboundDirectDmAccessWithRuntime({
      cfg: {
        ...baseCfg,
        accessGroups: {
          owners: {
            type: "message.senders",
            members: {
              nostr: ["owner-pubkey"],
              telegram: ["12345"],
            },
          },
        },
      } as OpenClawConfig,
      channel: "nostr",
      accountId: "default",
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:owners"],
      senderId: "owner-pubkey",
      rawBody: "/status",
      isSenderAllowed: (senderId, allowFrom) => allowFrom.includes(senderId),
      runtime: {
        shouldComputeCommandAuthorized: () => true,
        resolveCommandAuthorizedFromAuthorizers: ({ authorizers }) =>
          authorizers.some((entry) => entry.configured && entry.allowed),
      },
    });

    expect(result.access.decision).toBe("allow");
    expect(result.access.effectiveAllowFrom).toEqual(["accessGroup:owners", "owner-pubkey"]);
    expect(result.commandAuthorized).toBe(true);
  });

  it("creates a pre-crypto authorizer that issues pairing and blocks unknown senders", async () => {
    const issuePairingChallenge = vi.fn(async () => {});
    const onBlocked = vi.fn();
    const authorizer = createPreCryptoDirectDmAuthorizer({
      resolveAccess: async (senderId) => ({
        access:
          senderId === "pair-me"
            ? {
                decision: "pairing" as const,
                reasonCode: "dm_policy_pairing_required",
                reason: "dmPolicy=pairing (not allowlisted)",
                effectiveAllowFrom: [],
              }
            : {
                decision: "block" as const,
                reasonCode: "dm_policy_disabled",
                reason: "dmPolicy=disabled",
                effectiveAllowFrom: [],
              },
      }),
      issuePairingChallenge,
      onBlocked,
    });

    await expect(
      Promise.all([
        authorizer({
          senderId: "pair-me",
          reply: async () => {},
        }),
        authorizer({
          senderId: "blocked",
          reply: async () => {},
        }),
      ]),
    ).resolves.toEqual(["pairing", "block"]);

    expect(issuePairingChallenge).toHaveBeenCalledTimes(1);
    expect(onBlocked).toHaveBeenCalledWith({
      senderId: "blocked",
      reason: "dmPolicy=disabled",
      reasonCode: "dm_policy_disabled",
    });
  });

  it("builds a shared pre-crypto guard policy with partial overrides", () => {
    const policy = createDirectDmPreCryptoGuardPolicy({
      maxFutureSkewSec: 30,
      rateLimit: {
        maxPerSenderPerWindow: 5,
      },
    });

    expect(policy.allowedKinds).toEqual([4]);
    expect(policy.maxFutureSkewSec).toBe(30);
    expect(policy.maxCiphertextBytes).toBe(16 * 1024);
    expect(policy.rateLimit.maxPerSenderPerWindow).toBe(5);
    expect(policy.rateLimit.maxGlobalPerWindow).toBe(200);
  });

  it("defaults non-finite shared pre-crypto guard numeric overrides", () => {
    const policy = createDirectDmPreCryptoGuardPolicy({
      maxFutureSkewSec: Number.NaN,
      maxCiphertextBytes: Number.POSITIVE_INFINITY,
      maxPlaintextBytes: Number.NEGATIVE_INFINITY,
      rateLimit: {
        windowMs: Number.NaN,
        maxPerSenderPerWindow: Number.POSITIVE_INFINITY,
        maxGlobalPerWindow: Number.NEGATIVE_INFINITY,
        maxTrackedSenderKeys: Number.NaN,
      },
    });

    expect(policy.maxFutureSkewSec).toBe(120);
    expect(policy.maxCiphertextBytes).toBe(16 * 1024);
    expect(policy.maxPlaintextBytes).toBe(8 * 1024);
    expect(policy.rateLimit).toEqual({
      windowMs: 60_000,
      maxPerSenderPerWindow: 20,
      maxGlobalPerWindow: 200,
      maxTrackedSenderKeys: 4096,
    });
  });

  it("routes a targetless contextual reply to the inbound Reef peer", async () => {
    const { recordInboundSession, dispatchReplyWithBufferedBlockDispatcher, runtime } =
      createDirectDmRuntime();
    const deliver = vi.fn(async () => {});
    const channelIngress = await resolveStableChannelMessageIngress({
      channelId: "reef",
      accountId: "default",
      subject: { stableId: "clawstudio" },
      conversation: { kind: "direct", id: "clawstudio" },
      dmPolicy: "allowlist",
    });

    const result = await dispatchInboundDirectDmWithRuntime({
      channelIngress,
      cfg: {
        session: { store: { type: "jsonl" } },
      } as never,
      runtime,
      channel: "reef",
      channelLabel: "Reef",
      accountId: "default",
      peer: { kind: "direct", id: "clawstudio" },
      senderId: "clawstudio",
      senderAddress: "reef:clawstudio",
      recipientAddress: "reef:roboclaw",
      conversationLabel: "@clawstudio's agent",
      rawBody: "hello world",
      messageId: "event-123",
      extraContext: {
        ReplyToId: "event-parent",
        ReplyToIdFull: "event-parent",
        MessageThreadId: "thread-7",
      },
      timestamp: 1_710_000_000_000,
      commandAuthorized: true,
      deliver,
      onRecordError: () => {},
      onDispatchError: () => {},
    });

    expect(result.route.agentId).toBe("agent-main");
    expect(result.route.accountId).toBe("default");
    expect(result.route.sessionKey).toBe("dm:clawstudio");
    expect(result.storePath).toBe("/tmp/direct-dm-session-store");
    expect(result.ctxPayload.Body).toBe("env:hello world");
    expect(result.ctxPayload.BodyForAgent).toBe("hello world");
    expect(result.ctxPayload.From).toBe("reef:clawstudio");
    expect(result.ctxPayload.To).toBe("reef:roboclaw");
    expect(result.ctxPayload.SenderId).toBe("clawstudio");
    expect(result.ctxPayload.MessageSid).toBe("event-123");
    expect(result.ctxPayload.ReplyToId).toBe("event-parent");
    expect(result.ctxPayload.MessageThreadId).toBe("thread-7");
    expect(result.ctxPayload.NativeDirectUserId).toBe("clawstudio");
    expect(result.ctxPayload.OriginatingTo).toBe("reef:clawstudio");
    expect(result.ctxPayload.CommandAuthorized).toBe(true);
    const currentChannelId = result.ctxPayload.OriginatingTo ?? result.ctxPayload.To;
    expect(
      resolveImplicitMessageActionTarget({ currentChannelId, currentChannelProvider: "reef" }),
    ).toBe("reef:clawstudio");
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({ text: "reply text" });
  });

  it("keeps host admission and identity fields after extraContext is applied", async () => {
    const { runtime } = createDirectDmRuntime();
    const channelIngress = await resolveStableChannelMessageIngress({
      channelId: "reef",
      accountId: "default",
      subject: { stableId: "clawstudio" },
      conversation: { kind: "direct", id: "clawstudio" },
      dmPolicy: "allowlist",
    });

    const result = await dispatchInboundDirectDmWithRuntime({
      channelIngress,
      cfg: {
        session: { store: { type: "jsonl" } },
      } as never,
      runtime,
      channel: "reef",
      channelLabel: "Reef",
      accountId: "default",
      peer: { kind: "direct", id: "clawstudio" },
      senderId: "clawstudio",
      senderAddress: "reef:clawstudio",
      recipientAddress: "reef:roboclaw",
      conversationLabel: "@clawstudio's agent",
      rawBody: "hello world",
      messageId: "event-extra-1",
      commandAuthorized: false,
      inboundAccessAuthorized: true,
      extraContext: {
        CommandAuthorized: true,
        InboundAccessAuthorized: false,
        SessionKey: "extra:session",
        SenderId: "extra-sender",
        AccountId: "extra-acct",
        ChatType: "group",
        ConversationRouteContextObserved: false,
        NativeDirectUserId: "extra-peer",
        OriginatingChannel: "extra-channel",
        ChannelSpecificNote: "keep-me",
      },
      deliver: async () => {},
      onRecordError: () => {},
      onDispatchError: () => {},
    });

    expect(result.ctxPayload.CommandAuthorized).toBe(true);
    expect(result.ctxPayload.InboundAccessAuthorized).toBe(true);
    expect(result.ctxPayload.SessionKey).toBe("dm:clawstudio");
    expect(result.ctxPayload.SenderId).toBe("clawstudio");
    expect(result.ctxPayload.AccountId).toBe("default");
    expect(result.ctxPayload.ChatType).toBe("direct");
    expect(result.ctxPayload.ConversationRouteContextObserved).toBe(true);
    expect(result.ctxPayload.NativeDirectUserId).toBe("clawstudio");
    expect(result.ctxPayload.OriginatingChannel).toBe("reef");
    expect((result.ctxPayload as { ChannelSpecificNote?: unknown }).ChannelSpecificNote).toBe(
      "keep-me",
    );
  });
});
