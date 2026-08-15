import { describe, expect, it } from "vitest";
import {
  gatewayClientSenderFields,
  gatewayClientSessionCreator,
} from "./gateway-client-identity.js";
import type { GatewayClient } from "./types.js";

describe("gateway client identity", () => {
  it("overrides sender attribution without replacing the authorizing identity", () => {
    const client = {
      authenticatedUserProfile: {
        profileId: "owner",
        displayName: "Owner",
        hasAvatar: false,
        updatedAt: 1,
      },
      internal: {
        syntheticClient: true,
        senderAttribution: { id: "alice", name: "Suggested by Alice" },
      },
    } as GatewayClient;

    expect(gatewayClientSessionCreator(client)).toEqual({
      type: "human",
      id: "owner",
      label: "Owner",
    });
    expect(gatewayClientSenderFields(client)).toEqual({
      sender: { id: "alice", name: "Suggested by Alice" },
    });
  });
});
