import { describe, expect, it } from "vitest";
import type { AgentRouteBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveFirstBoundAccountId } from "./bound-account-read.js";

function cfgWithBindings(bindings: AgentRouteBinding[]): OpenClawConfig {
  return { bindings } as unknown as OpenClawConfig;
}

describe("resolveFirstBoundAccountId", () => {
  it("returns exact peer match when caller supplies a matching peerId", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "matrix", accountId: "bot-alpha-default" },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "!roomA:example.org" },
          accountId: "bot-alpha-room-a",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!roomA:example.org",
      }),
    ).toBe("bot-alpha-room-a");
  });

  it("prefers wildcard peer binding over channel-only when caller peerKind matches", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "matrix", accountId: "bot-alpha-default" },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "*" },
          accountId: "bot-alpha-wildcard",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!anyRoom:example.org",
        peerKind: "channel",
      }),
    ).toBe("bot-alpha-wildcard");
  });

  it("preserves first-match binding order for peerless callers", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "*" },
          accountId: "bot-alpha-wildcard",
        },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "matrix", accountId: "bot-alpha-default" },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
      }),
    ).toBe("bot-alpha-wildcard");
  });

  it("falls back to peer-specific binding for peerless callers when no channel-only or wildcard binding exists", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "!specificRoom:example.org" },
          accountId: "bot-alpha-specific",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
      }),
    ).toBe("bot-alpha-specific");
  });

  it("skips non-matching peer-specific bindings when caller supplies a different peerId", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "!otherRoom:example.org" },
          accountId: "bot-alpha-other",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!differentRoom:example.org",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the agent has no binding on the channel", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "whatsapp", accountId: "bot-alpha-whatsapp" },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
      }),
    ).toBeUndefined();
  });

  it("filters bindings by peer kind when caller supplies peerKind", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "direct", id: "*" },
          accountId: "bot-alpha-dm",
        },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "*" },
          accountId: "bot-alpha-room",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!room:example.org",
        peerKind: "channel",
      }),
    ).toBe("bot-alpha-room");
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "@user:example.org",
        peerKind: "direct",
      }),
    ).toBe("bot-alpha-dm");
  });

  it("treats group and channel peer kinds as equivalent (matches resolve-route semantics)", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "line",
          peer: { kind: "group", id: "*" },
          accountId: "bot-alpha-group",
        },
      },
    ]);
    // Caller inferred as `channel` (e.g. Matrix room, Mattermost channel)
    // should still match a `group` wildcard binding because group/channel are
    // compatible kinds in the routing model.
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "line",
        agentId: "bot-alpha",
        peerId: "!roomA:example.org",
        peerKind: "channel",
      }),
    ).toBe("bot-alpha-group");
    // And vice versa: `channel` binding matches a `group` caller.
    const cfg2 = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "line",
          peer: { kind: "channel", id: "*" },
          accountId: "bot-alpha-channel",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg: cfg2,
        channelId: "line",
        agentId: "bot-alpha",
        peerId: "groupA",
        peerKind: "group",
      }),
    ).toBe("bot-alpha-channel");
  });

  it("accepts a wildcard peer binding as fallback for peerless callers", () => {
    // Cron-style peerless caller: we have no peer context to verify kind
    // safety against, so a wildcard binding is the only available answer and
    // must not silently regress to undefined.
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "*" },
          accountId: "bot-alpha-wildcard",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
      }),
    ).toBe("bot-alpha-wildcard");
  });

  it("skips wildcard peer bindings when the caller's peerKind is unknown", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "direct", id: "*" },
          accountId: "bot-alpha-dm",
        },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "matrix", accountId: "bot-alpha-default" },
      },
    ]);
    // Without a peerKind on the caller, we cannot verify kind compatibility
    // for the wildcard binding — it must be skipped in favor of the channel-only
    // fallback rather than risk routing to the wrong identity.
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!room:example.org",
      }),
    ).toBe("bot-alpha-default");
  });

  it("matches exact peer id even when the caller's peerKind is unknown", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "channel", id: "!room:example.org" },
          accountId: "bot-alpha-room",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!room:example.org",
      }),
    ).toBe("bot-alpha-room");
  });

  it("matches exact canonical peer aliases before falling back to wildcard bindings", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "qa-channel",
          peer: { kind: "channel", id: "*" },
          accountId: "bot-alpha-wildcard",
        },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "qa-channel",
          peer: { kind: "channel", id: "channel:conversation-a" },
          accountId: "bot-alpha-conversation",
        },
      },
    ]);
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "qa-channel",
        agentId: "bot-alpha",
        peerId: "conversation-a",
        exactPeerIdAliases: ["channel:conversation-a"],
        peerKind: "channel",
      }),
    ).toBe("bot-alpha-conversation");
  });

  it("skips peer-specific bindings whose kind does not match the caller's peerKind", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "matrix",
          peer: { kind: "direct", id: "!room:example.org" },
          accountId: "bot-alpha-wrong-kind",
        },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "matrix", accountId: "bot-alpha-default" },
      },
    ]);
    // Caller peerKind=channel: the direct-kind binding is ineligible even though
    // its peerId would match — falls through to the channel-only binding.
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "matrix",
        agentId: "bot-alpha",
        peerId: "!room:example.org",
        peerKind: "channel",
      }),
    ).toBe("bot-alpha-default");
  });

  it("skips scoped bindings when the caller has no matching group space", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "discord",
          guildId: "guild-other",
          accountId: "bot-alpha-other-guild",
        },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "discord", accountId: "bot-alpha-default" },
      },
    ]);

    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "discord",
        agentId: "bot-alpha",
        groupSpace: "guild-current",
      }),
    ).toBe("bot-alpha-default");
  });

  it("matches scoped guild and team bindings against caller group space", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "discord",
          guildId: "guild-current",
          accountId: "bot-alpha-guild",
        },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "slack",
          teamId: "team-current",
          accountId: "bot-alpha-team",
        },
      },
    ]);

    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "discord",
        agentId: "bot-alpha",
        groupSpace: "guild-current",
      }),
    ).toBe("bot-alpha-guild");
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "slack",
        agentId: "bot-alpha",
        groupSpace: "team-current",
      }),
    ).toBe("bot-alpha-team");
  });

  it("requires caller roles before selecting role-scoped bindings", () => {
    const cfg = cfgWithBindings([
      {
        type: "route",
        agentId: "bot-alpha",
        match: {
          channel: "discord",
          guildId: "guild-current",
          roles: ["admin"],
          accountId: "bot-alpha-admin",
        },
      },
      {
        type: "route",
        agentId: "bot-alpha",
        match: { channel: "discord", accountId: "bot-alpha-default" },
      },
    ]);

    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "discord",
        agentId: "bot-alpha",
        groupSpace: "guild-current",
        memberRoleIds: ["member"],
      }),
    ).toBe("bot-alpha-default");
    expect(
      resolveFirstBoundAccountId({
        cfg,
        channelId: "discord",
        agentId: "bot-alpha",
        groupSpace: "guild-current",
        memberRoleIds: ["admin"],
      }),
    ).toBe("bot-alpha-admin");
  });
});
