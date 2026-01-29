import { describe, expect, it, vi } from "vitest";
import { createSoftLCT } from "./soft-lct.js";

vi.mock("node:os", () => ({
  hostname: () => "test-host",
  userInfo: () => ({ username: "test-user" }),
}));

describe("createSoftLCT", () => {
  it("should return a token with the correct structure", () => {
    const token = createSoftLCT("session-123");
    expect(token).toMatchObject({
      sessionId: "session-123",
      bindingType: "software",
    });
    expect(token.tokenId).toMatch(/^web4:session:[a-f0-9]{8}:session-/);
    expect(token.machineHash).toMatch(/^[a-f0-9]{8}$/);
    expect(token.createdAt).toBeTruthy();
  });

  it("should produce a deterministic machineHash for same host+user", () => {
    const a = createSoftLCT("s1");
    const b = createSoftLCT("s2");
    expect(a.machineHash).toBe(b.machineHash);
  });

  it("should truncate sessionId to first 8 chars in tokenId", () => {
    const token = createSoftLCT("abcdefghijklmnop");
    expect(token.tokenId).toContain(":abcdefgh");
    expect(token.tokenId).not.toContain("ijklmnop");
  });

  it("should set createdAt to a valid ISO timestamp", () => {
    const token = createSoftLCT("s1");
    expect(new Date(token.createdAt).toISOString()).toBe(token.createdAt);
  });
});
