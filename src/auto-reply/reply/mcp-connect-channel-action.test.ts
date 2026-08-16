import { describe, expect, it } from "vitest";
import { renderMessagePresentationFallbackText } from "../../interactive/payload.js";
import { attachMcpConnectChannelAction } from "./mcp-connect-channel-action.js";

describe("attachMcpConnectChannelAction", () => {
  it("adds one portable URL action to the final visible reply", () => {
    const payloads = attachMcpConnectChannelAction({
      payloads: [{ text: "progress", isStatusNotice: true }, { text: "Sign in to continue." }],
      action: {
        serverName: "calendar",
        authorizationUrl: "https://auth.example/authorize?state=opaque",
      },
    });

    expect(renderMessagePresentationFallbackText(payloads[1]!)).toBe(
      "Sign in to continue.\n\n- Connect calendar: https://auth.example/authorize?state=opaque",
    );
  });

  it("preserves payloads without an action or eligible terminal reply", () => {
    const payloads = [{ text: "failed", isError: true }];
    expect(attachMcpConnectChannelAction({ payloads })).toBe(payloads);
    expect(
      attachMcpConnectChannelAction({
        payloads,
        action: { serverName: "calendar", authorizationUrl: "https://auth.example/authorize" },
      }),
    ).toBe(payloads);
  });
});
