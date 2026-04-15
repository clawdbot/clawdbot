import { describe, expect, it } from "vitest";
import { canonicalizeLegacySessionKey, isLegacyGroupSessionKey } from "./session-contract.js";

describe("whatsapp legacy session contract", () => {
  it("canonicalizes legacy WhatsApp group keys to channel-qualified agent keys", () => {
    expect(canonicalizeLegacySessionKey({ key: "group:123@g.us", agentId: "main" })).toBe(
      "agent:main:whatsapp:group:123@g.us",
    );
    expect(canonicalizeLegacySessionKey({ key: "123@g.us", agentId: "main" })).toBe(
      "agent:main:whatsapp:group:123@g.us",
    );
    expect(canonicalizeLegacySessionKey({ key: "whatsapp:123@g.us", agentId: "main" })).toBe(
      "agent:main:whatsapp:group:123@g.us",
    );
  });

  it("does not claim generic non-WhatsApp group keys", () => {
    expect(isLegacyGroupSessionKey("group:abc")).toBe(false);
    expect(canonicalizeLegacySessionKey({ key: "group:abc", agentId: "main" })).toBeNull();
  });
});
