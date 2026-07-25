import { describe, expect, it } from "vitest";
import { linePlugin } from "./channel.js";

const userId = `U${"a".repeat(32)}`;
const groupId = `C${"b".repeat(32)}`;
const roomId = `R${"c".repeat(32)}`;

describe("LINE outbound session routing", () => {
  it.each([
    [userId, "direct", `line:${userId}`],
    [groupId, "group", `line:group:${groupId}`],
    [roomId, "group", `line:room:${roomId}`],
  ] as const)("maps %s to the canonical inbound peer", async (target, kind, from) => {
    const route = await linePlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target,
    });

    expect(route).toMatchObject({
      recipientSessionExact: true,
      peer: { kind, id: target },
      from,
      to: target,
    });
  });
});
