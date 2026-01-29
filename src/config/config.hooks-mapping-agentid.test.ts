import { describe, expect, it, vi } from "vitest";

describe("hooks.mappings agentId validation", () => {
  it("accepts valid agentId in hook mapping", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      agents: {
        list: [{ id: "email-handler" }, { id: "default" }],
      },
      hooks: {
        enabled: true,
        token: "test-token",
        mappings: [
          {
            id: "email-hook",
            match: { path: "email" },
            action: "agent",
            agentId: "email-handler",
            messageTemplate: "New email",
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown agentId in hook mapping", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      agents: {
        list: [{ id: "default" }],
      },
      hooks: {
        enabled: true,
        token: "test-token",
        mappings: [
          {
            id: "email-hook",
            match: { path: "email" },
            action: "agent",
            agentId: "nonexistent-agent",
            messageTemplate: "New email",
          },
        ],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const messages = res.issues.map((i) => i.message).join(" ");
      expect(messages).toContain("nonexistent-agent");
      expect(messages).toContain("not in agents.list");
    }
  });

  it("accepts hook mapping without agentId (uses default)", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      agents: {
        list: [{ id: "default" }],
      },
      hooks: {
        enabled: true,
        token: "test-token",
        mappings: [
          {
            id: "email-hook",
            match: { path: "email" },
            action: "agent",
            messageTemplate: "New email",
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("skips agentId validation when agents.list is empty", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      hooks: {
        enabled: true,
        token: "test-token",
        mappings: [
          {
            id: "email-hook",
            match: { path: "email" },
            action: "agent",
            agentId: "any-agent",
            messageTemplate: "New email",
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
  });
});
