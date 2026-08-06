import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { resolveNostrOutboundSessionRoute } from "./session-route.js";

describe("Nostr outbound session routing", () => {
  it("normalizes npub aliases to the inbound hex peer identity", () => {
    const hexPubkey = "010203040502c2081bdec91624b96cb7863f63150720e64764a214d80a0101cf";
    const route = resolveNostrOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: nip19.npubEncode(hexPubkey),
    });

    expect(route).toMatchObject({
      recipientSessionExact: true,
      peer: {
        kind: "direct",
        id: hexPubkey,
      },
    });
  });
});
