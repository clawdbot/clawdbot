import { describe, it, expect } from "vitest";
import { normalizeAgentPayload } from "../src/gateway/hooks.js";

describe("normalizeAgentPayload agentId support", () => {
  it("should accept agentId as a string", () => {
    const payload = {
      message: "test message",
      channel: "last",
      agentId: "agent-123",
    };
    const result = normalizeAgentPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agentId).toBe("agent-123");
    }
  });

  it("should trim agentId whitespace", () => {
    const payload = {
      message: "test message",
      channel: "last",
      agentId: "  agent-456  ",
    };
    const result = normalizeAgentPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agentId).toBe("agent-456");
    }
  });

  it("should handle missing agentId as undefined", () => {
    const payload = {
      message: "test message",
      channel: "last",
    };
    const result = normalizeAgentPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agentId).toBeUndefined();
    }
  });

  it("should ignore empty agentId strings", () => {
    const payload = {
      message: "test message",
      channel: "last",
      agentId: "  ",
    };
    const result = normalizeAgentPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agentId).toBeUndefined();
    }
  });

  it("should handle non-string agentId as undefined", () => {
    const payload = {
      message: "test message",
      channel: "last",
      agentId: 123,
    } as any;
    const result = normalizeAgentPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.agentId).toBeUndefined();
    }
  });
});
