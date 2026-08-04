import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import { buzzPlugin } from "./channel.js";

const ROOM_ID = "64f4debf-e7af-438c-8dcd-d6fbbe77405d";

describe("Buzz channel guidance", () => {
  it("advertises directory room targets and native mention syntax", () => {
    const hints = buzzPlugin.agentPrompt?.messageToolHints?.({} as never) ?? [];

    expect(hints).toContain(
      "- Buzz targets: use a configured room UUID, `buzz:<ROOM_UUID>`, or a unique current room name. Use the UUID when room names are ambiguous.",
    );
    expect(hints).toContain(
      "- Buzz mentions: write a unique current room member as `@Display Name`. For an explicit identity, include `nostr:npub...`; the public key must belong to the target room. Any unresolved or ambiguous label needs an explicit identity for every intended member.",
    );
    expect(buzzPlugin.messaging?.targetResolver?.hint).toBe("<room UUID|configured room name>");
  });

  it("resolves Buzz reply sessions without treating the thread as part of the room UUID", () => {
    const threadId = "584e8d00bab48310ea80ff5f62550f824242bbc333fc4c259d7ae80be025c8aa";

    expect(
      buzzPlugin.messaging?.resolveSessionConversation?.({
        kind: "group",
        rawId: `buzz:${ROOM_ID}:thread:${threadId}`,
      }),
    ).toEqual({
      id: ROOM_ID,
      threadId,
      baseConversationId: ROOM_ID,
      parentConversationCandidates: [ROOM_ID],
    });
  });

  it("keeps same-room agent sessions isolated by Buzz account", async () => {
    const resolveRoute = buzzPlugin.messaging?.resolveOutboundSessionRoute;
    if (!resolveRoute) {
      throw new Error("expected Buzz outbound session routing");
    }
    const cfg = {
      agents: {
        list: [{ id: "support" }, { id: "engineering" }],
      },
      bindings: [
        { agentId: "support", match: { channel: "buzz", accountId: "support" } },
        { agentId: "engineering", match: { channel: "buzz", accountId: "engineering" } },
      ],
    } as OpenClawConfig;

    const supportInbound = resolveAgentRoute({
      cfg,
      channel: "buzz",
      accountId: "support",
      peer: { kind: "group", id: `buzz:${ROOM_ID}` },
    });
    const engineeringInbound = resolveAgentRoute({
      cfg,
      channel: "buzz",
      accountId: "engineering",
      peer: { kind: "group", id: `buzz:${ROOM_ID}` },
    });
    expect(supportInbound.agentId).toBe("support");
    expect(engineeringInbound.agentId).toBe("engineering");

    const support = await resolveRoute({
      cfg,
      agentId: supportInbound.agentId,
      accountId: "support",
      target: ROOM_ID,
    });
    const engineering = await resolveRoute({
      cfg,
      agentId: engineeringInbound.agentId,
      accountId: "engineering",
      target: ROOM_ID,
    });

    expect(support).toMatchObject({ to: `buzz:${ROOM_ID}` });
    expect(engineering).toMatchObject({ to: `buzz:${ROOM_ID}` });
    if (!support || !engineering) {
      throw new Error("expected Buzz account routes");
    }
    expect(support.sessionKey).not.toBe(engineering.sessionKey);
  });
});
