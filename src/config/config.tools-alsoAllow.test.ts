import { describe, expect, it } from "vitest";

import { validateConfigObject } from "./validation.js";

// NOTE: These tests ensure allow + alsoAllow cannot be set in the same scope.

describe("config: tools.alsoAllow", () => {
  it("rejects tools.allow + tools.alsoAllow together", () => {
    const res = validateConfigObject({
      tools: {
        allow: ["group:fs"],
        alsoAllow: ["lobster"],
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "tools")).toBe(true);
    }
  });

  it("rejects agents.list[].tools.allow + alsoAllow together", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "main",
            tools: {
              allow: ["group:fs"],
              alsoAllow: ["lobster"],
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path.includes("agents.list"))).toBe(true);
    }
  });

  it("allows profile + alsoAllow", () => {
    const res = validateConfigObject({
      tools: {
        profile: "coding",
        alsoAllow: ["lobster"],
      },
    });

    expect(res.ok).toBe(true);
  });
});
