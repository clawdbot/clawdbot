import { describe, expect, it } from "vitest";

import { isSlackRoomAllowedByPolicy } from "./monitor.js";

describe("slack groupPolicy gating", () => {
  it("allows when policy is open", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "open",
        channelAllowlistConfigured: false,
        channelAllowed: false,
      }),
    ).toBe(true);
  });

  it("blocks when policy is disabled", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "disabled",
        channelAllowlistConfigured: true,
        channelAllowed: true,
      }),
    ).toBe(false);
  });

  it("blocks allowlist when no channel allowlist configured", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "allowlist",
        channelAllowlistConfigured: false,
        channelAllowed: true,
      }),
    ).toBe(false);
  });

  it("allows allowlist when channel is allowed", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "allowlist",
        channelAllowlistConfigured: true,
        channelAllowed: true,
      }),
    ).toBe(true);
  });

  it("blocks allowlist when channel is not allowed", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "allowlist",
        channelAllowlistConfigured: true,
        channelAllowed: false,
      }),
    ).toBe(false);
  });
});
