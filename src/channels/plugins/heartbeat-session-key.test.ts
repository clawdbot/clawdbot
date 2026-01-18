import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../../config/config.js";
import { resolveAgentIdFromSessionKey, resolveMainSessionKey } from "../../config/sessions.js";
import { buildAgentPeerSessionKey } from "../../routing/session-key.js";
import { buildTelegramGroupPeerId } from "../../telegram/bot/helpers.js";
import { getChannelPlugin } from "./index.js";

describe("heartbeat session key resolution", () => {
  it("resolves discord channel targets", () => {
    const cfg: ClawdbotConfig = {};
    const mainSessionKey = resolveMainSessionKey(cfg);
    const agentId = resolveAgentIdFromSessionKey(mainSessionKey);
    const expected = buildAgentPeerSessionKey({
      agentId,
      channel: "discord",
      peerKind: "channel",
      peerId: "123",
    });

    const plugin = getChannelPlugin("discord");
    const actual = plugin?.messaging?.resolveTargetSessionKey({
      cfg,
      mainSessionKey,
      to: "channel:123",
    });

    expect(actual).toBe(expected);
  });

  it("resolves telegram topic targets as group sessions", () => {
    const cfg: ClawdbotConfig = {};
    const mainSessionKey = resolveMainSessionKey(cfg);
    const agentId = resolveAgentIdFromSessionKey(mainSessionKey);
    const peerId = buildTelegramGroupPeerId("-1001234567890", 456);
    const expected = buildAgentPeerSessionKey({
      agentId,
      channel: "telegram",
      peerKind: "group",
      peerId,
    });

    const plugin = getChannelPlugin("telegram");
    const actual = plugin?.messaging?.resolveTargetSessionKey({
      cfg,
      mainSessionKey,
      to: "-1001234567890:topic:456",
    });

    expect(actual).toBe(expected);
  });
});
