import { describe, expect, it, vi } from "vitest";
import type { ConversationIdentity } from "../config/sessions/conversation-identity.js";
import { runGatewayConversationList } from "./conversation-list.js";

describe("runGatewayConversationList", () => {
  it("discovers a trusted directory peer without creating a session", async () => {
    let discovered: ConversationIdentity[] = [];
    const listPeers = vi.fn(async () => [
      { kind: "user" as const, id: "peer-id-123", name: "Friendly Lobster", handle: "@molty" },
    ]);
    const resolveOutboundSessionRoute = vi.fn(async () => ({
      sessionKey: "agent:main:reef:direct:peer-id-123",
      baseSessionKey: "agent:main:reef:direct:peer-id-123",
      peer: { kind: "direct" as const, id: "peer-id-123" },
      chatType: "direct" as const,
      from: "reef:peer-id-123",
      to: "reef:peer-id-123",
    }));
    const deps = {
      resolveOutboundChannelPlugin: vi.fn(() => ({
        id: "reef",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ enabled: true, configured: true }),
          isEnabled: () => true,
          isConfigured: () => true,
        },
        directory: { listPeers, listGroups: async () => [] },
      })),
      resolveOutboundSessionRoute,
      registerConversationAddresses: vi.fn((_scope, identities) => {
        discovered = [...identities];
      }),
      listConversations: vi.fn(() =>
        discovered.map((identity) => ({
          conversationRef: identity.conversationRef,
          channel: identity.channel,
          accountId: identity.accountId,
          kind: identity.kind,
          target: identity.deliveryTarget,
          label: identity.label,
          firstSeenAt: 100,
          lastSeenAt: 100,
        })),
      ),
    };

    const result = await runGatewayConversationList(
      { config: {}, agentId: "main", channel: "reef", query: "@molty", limit: 50 },
      deps as never,
    );

    expect(listPeers).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default", query: "@molty", limit: 50 }),
    );
    expect(deps.listConversations).toHaveBeenCalledWith({ agentId: "main" }, { channel: "reef" });
    expect(resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "reef",
        agentId: "main",
        accountId: "default",
        target: "peer-id-123",
        resolvedTarget: {
          to: "peer-id-123",
          kind: "user",
          display: "Friendly Lobster",
          source: "directory",
          resolutionSource: "directory",
        },
      }),
    );
    expect(result.conversations).toEqual([
      expect.objectContaining({
        conversationRef: expect.stringMatching(/^conv_[a-f0-9]{32}$/u),
        channel: "reef",
        accountId: "default",
        kind: "direct",
        target: "reef:peer-id-123",
        label: "Friendly Lobster",
      }),
    ]);
    expect(result.conversations[0]).not.toHaveProperty("sessionId");
  });

  it("keeps route identity separate from its delivery address", async () => {
    let discovered: ConversationIdentity[] = [];
    const deps = {
      resolveOutboundChannelPlugin: vi.fn(() => ({
        id: "discord",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ enabled: true, configured: true }),
          isEnabled: () => true,
          isConfigured: () => true,
        },
        directory: {
          listPeers: async () => [
            { kind: "user" as const, id: "delivery-alias-456", name: "Canonical Peer" },
          ],
          listGroups: async () => [],
        },
      })),
      resolveOutboundSessionRoute: vi.fn(async () => ({
        sessionKey: "agent:main:discord:direct:canonical-peer-123",
        baseSessionKey: "agent:main:discord:direct:canonical-peer-123",
        peer: { kind: "direct" as const, id: "canonical-peer-123" },
        chatType: "direct" as const,
        from: "discord:canonical-peer-123",
        to: "user:delivery-alias-456",
      })),
      registerConversationAddresses: vi.fn((_scope, identities) => {
        discovered = [...identities];
      }),
      listConversations: vi.fn(() => []),
    };

    await runGatewayConversationList(
      { config: {}, agentId: "main", channel: "discord", limit: 50 },
      deps as never,
    );

    expect(discovered).toEqual([
      expect.objectContaining({
        peerId: "canonical-peer-123",
        deliveryTarget: "user:delivery-alias-456",
        nativeDirectUserId: "canonical-peer-123",
      }),
    ]);
  });

  it("merges live directory adapters with config-backed entries", async () => {
    const listPeers = vi.fn(async () => [
      { kind: "user" as const, id: "stale-peer", name: "Stale Peer" },
      { kind: "user" as const, id: "shared-peer", name: "Configured Shared Peer" },
    ]);
    const listPeersLive = vi.fn(async () => [
      { kind: "user" as const, id: "live-peer", name: "Live Peer" },
      { kind: "user" as const, id: "shared-peer", name: "Live Shared Peer" },
    ]);
    const listGroups = vi.fn(async () => [
      { kind: "group" as const, id: "stale-group", name: "Stale Group" },
    ]);
    const listGroupsLive = vi.fn(async () => [
      { kind: "group" as const, id: "live-group", name: "Live Group" },
    ]);
    const resolvedTargets: string[] = [];
    const deps = {
      resolveOutboundChannelPlugin: vi.fn(() => ({
        id: "discord",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ enabled: true, configured: true }),
          isEnabled: () => true,
          isConfigured: () => true,
        },
        directory: { listPeers, listPeersLive, listGroups, listGroupsLive },
      })),
      resolveOutboundSessionRoute: vi.fn(async ({ target }: { target: string }) => {
        resolvedTargets.push(target);
        const direct = target.endsWith("-peer");
        return {
          sessionKey: `agent:main:discord:${direct ? "direct" : "channel"}:${target}`,
          baseSessionKey: `agent:main:discord:${direct ? "direct" : "channel"}:${target}`,
          peer: { kind: direct ? ("direct" as const) : ("channel" as const), id: target },
          chatType: direct ? ("direct" as const) : ("channel" as const),
          from: `discord:${target}`,
          to: target,
        };
      }),
      registerConversationAddresses: vi.fn(),
      listConversations: vi.fn(() => []),
    };

    await runGatewayConversationList(
      { config: {}, agentId: "main", channel: "discord", limit: 50 },
      deps as never,
    );

    expect(listPeersLive).toHaveBeenCalledOnce();
    expect(listGroupsLive).toHaveBeenCalledOnce();
    expect(listPeers).toHaveBeenCalledOnce();
    expect(listGroups).toHaveBeenCalledOnce();
    expect(resolvedTargets).toEqual([
      "stale-peer",
      "shared-peer",
      "live-peer",
      "stale-group",
      "live-group",
    ]);
    expect(deps.resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "shared-peer",
        resolvedTarget: expect.objectContaining({ display: "Live Shared Peer" }),
      }),
    );
  });

  it("retains configured peers when live discovery is empty or fails", async () => {
    const listPeers = vi.fn(async () => [
      { kind: "user" as const, id: "configured-peer", name: "Configured Peer" },
    ]);
    const listPeersLive = vi.fn(async ({ query }: { query?: string }) =>
      query ? [{ kind: "user" as const, id: "live-peer", name: "Live Peer" }] : [],
    );
    listPeersLive.mockRejectedValueOnce(new Error("directory unavailable"));
    const resolvedTargets: string[] = [];
    const deps = {
      resolveOutboundChannelPlugin: vi.fn(() => ({
        id: "discord",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ enabled: true, configured: true }),
          isEnabled: () => true,
          isConfigured: () => true,
        },
        directory: { listPeers, listPeersLive },
      })),
      resolveOutboundSessionRoute: vi.fn(async ({ target }: { target: string }) => {
        resolvedTargets.push(target);
        return {
          sessionKey: `agent:main:discord:direct:${target}`,
          baseSessionKey: `agent:main:discord:direct:${target}`,
          peer: { kind: "direct" as const, id: target },
          chatType: "direct" as const,
          from: `discord:${target}`,
          to: target,
        };
      }),
      registerConversationAddresses: vi.fn(),
      listConversations: vi.fn(() => []),
    };

    await runGatewayConversationList(
      { config: {}, agentId: "main", channel: "discord", limit: 50 },
      deps as never,
    );
    await runGatewayConversationList(
      { config: {}, agentId: "main", channel: "discord", limit: 50 },
      deps as never,
    );

    expect(listPeers).toHaveBeenCalledTimes(2);
    expect(listPeersLive).toHaveBeenCalledTimes(2);
    expect(listPeersLive.mock.calls.map(([input]) => input)).toEqual([
      expect.not.objectContaining({ query: expect.anything() }),
      expect.not.objectContaining({ query: expect.anything() }),
    ]);
    expect(resolvedTargets).toEqual(["configured-peer", "configured-peer"]);
  });
});
