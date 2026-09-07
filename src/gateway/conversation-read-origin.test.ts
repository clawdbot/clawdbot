import { describe, expect, it } from "vitest";
import { resolveGatewayConversationReadOrigin } from "./conversation-read-origin.js";

describe("resolveGatewayConversationReadOrigin", () => {
  it("honors the operation-local direct-operator marker", () => {
    expect(
      resolveGatewayConversationReadOrigin({
        client: undefined,
        requestedOrigin: "direct-operator",
      }),
    ).toBe("direct-operator");
  });

  it.each([undefined, null, "delegated", "unknown"])(
    "keeps missing or unknown operation origins delegated",
    (requestedOrigin) => {
      expect(
        resolveGatewayConversationReadOrigin({
          client: undefined,
          requestedOrigin,
        }),
      ).toBe("delegated");
    },
  );

  it("does not infer direct authority from CLI connection metadata", () => {
    expect(
      resolveGatewayConversationReadOrigin({
        client: {
          connect: {
            client: {
              id: "cli",
              mode: "cli",
            },
          },
        } as never,
      }),
    ).toBe("delegated");
  });

  it("keeps an agent runtime delegated even with a direct-operator marker", () => {
    expect(
      resolveGatewayConversationReadOrigin({
        client: {
          internal: {
            agentRuntimeIdentity: {
              kind: "agentRuntime",
              agentId: "main",
              sessionKey: "agent:main:main",
            },
          },
        } as never,
        requestedOrigin: "direct-operator",
      }),
    ).toBe("delegated");
  });
});
