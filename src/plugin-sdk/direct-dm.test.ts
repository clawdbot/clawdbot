import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createDirectDmPreCryptoGuardPolicy,
  createPreCryptoDirectDmAuthorizer,
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
} from "./direct-dm.js";

const baseCfg = {
  commands: { useAccessGroups: true },
} as unknown as OpenClawConfig;

function createDirectDmRuntime() {
  const recordInboundSession = vi.fn(async () => {});
  const dispatchReplyWithBufferedBlockDispatcher = vi.fn(async ({ dispatcherOptions }) => {
    await dispatcherOptions.deliver({ text: "reply text" });
  });
  return {
    recordInboundSession,
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
          recordInboundSession,
        },
        reply: {
          resolveEnvelopeFormatOptions: vi.fn(() => ({ mode: "agent" })),
          formatAgentEnvelope: vi.fn(({ body }) => `env:${body}`),
          finalizeInboundContext: vi.fn((ctx) => ctx),
          dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    } as never,
  };
}

describe("plugin-sdk/direct-dm", () => {
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
    expect(result.access.effectiveAllowFrom).toEqual([]);
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

  it("dispatches direct DMs through the standard route/session/reply pipeline", async () => {
    const { recordInboundSession, dispatchReplyWithBufferedBlockDispatcher, runtime } =
      createDirectDmRuntime();
    const deliver = vi.fn(async () => {});

    const result = await dispatchInboundDirectDmWithRuntime({
      cfg: {
        session: { store: { type: "jsonl" } },
      } as never,
      runtime,
      channel: "nostr",
      channelLabel: "Nostr",
      accountId: "default",
      peer: { kind: "direct", id: "sender-1" },
      senderId: "sender-1",
      senderAddress: "nostr:sender-1",
      recipientAddress: "nostr:bot-1",
      conversationLabel: "sender-1",
      rawBody: "hello world",
      messageId: "event-123",
      timestamp: 1_710_000_000_000,
      commandAuthorized: true,
      deliver,
      onRecordError: () => {},
      onDispatchError: () => {},
    });

    expect(result.route).toMatchObject({
      agentId: "agent-main",
      accountId: "default",
      sessionKey: "dm:sender-1",
    });
    expect(result.storePath).toBe("/tmp/direct-dm-session-store");
    expect(result.ctxPayload).toMatchObject({
      Body: "env:hello world",
      BodyForAgent: "hello world",
      From: "nostr:sender-1",
      To: "nostr:bot-1",
      SenderId: "sender-1",
      MessageSid: "event-123",
      CommandAuthorized: true,
    });
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({ text: "reply text" });
  });
});
