// Node presence tests cover alive reason normalization for heartbeat metadata.
import { describe, expect, it } from "vitest";
import { NODE_PRESENCE_ALIVE_EVENT, normalizeNodePresenceAliveReason } from "./node-presence.js";

describe("NODE_PRESENCE_ALIVE_EVENT", () => {
  it("is the expected gateway event name", () => {
    expect(NODE_PRESENCE_ALIVE_EVENT).toBe("node.presence.alive");
  });
});

describe("normalizeNodePresenceAliveReason", () => {
  it("passes through known canonical reasons", () => {
    expect(normalizeNodePresenceAliveReason("background")).toBe("background");
    expect(normalizeNodePresenceAliveReason("silent_push")).toBe("silent_push");
    expect(normalizeNodePresenceAliveReason("manual")).toBe("manual");
    expect(normalizeNodePresenceAliveReason("connect")).toBe("connect");
    expect(normalizeNodePresenceAliveReason("bg_app_refresh")).toBe("bg_app_refresh");
    expect(normalizeNodePresenceAliveReason("significant_location")).toBe("significant_location");
  });

  it("is case-insensitive", () => {
    expect(normalizeNodePresenceAliveReason("MANUAL")).toBe("manual");
    expect(normalizeNodePresenceAliveReason("Background")).toBe("background");
  });

  it("trims whitespace from input", () => {
    expect(normalizeNodePresenceAliveReason("  manual  ")).toBe("manual");
  });

  it("defaults to background for unknown values", () => {
    expect(normalizeNodePresenceAliveReason("unknown")).toBe("background");
    expect(normalizeNodePresenceAliveReason("")).toBe("background");
  });

  it("defaults to background for non-string values", () => {
    expect(normalizeNodePresenceAliveReason(undefined)).toBe("background");
    expect(normalizeNodePresenceAliveReason(null)).toBe("background");
    expect(normalizeNodePresenceAliveReason(123)).toBe("background");
  });
});
