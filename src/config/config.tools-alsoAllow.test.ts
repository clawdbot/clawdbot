// Covers tools alsoAllow config parsing and validation.
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
      expect(res.issues.map((issue) => issue.path)).toContain("tools");
    }
  });

  it("rejects agents.entries.*.tools.allow + alsoAllow together", () => {
    const res = validateConfigObject({
      agents: {
        entries: {
          main: {
            tools: {
              allow: ["group:fs"],
              alsoAllow: ["lobster"],
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.map((issue) => issue.path)).toContain("agents.entries.main.tools");
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

  it("allows per-agent message tool cross-context policy", () => {
    const res = validateConfigObject({
      agents: {
        entries: {
          sandbox: {
            tools: {
              message: {
                crossContext: {
                  allowWithinProvider: false,
                  allowAcrossProviders: false,
                },
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("allows per-agent message tool action allowlists", () => {
    const res = validateConfigObject({
      agents: {
        entries: {
          sandbox: {
            tools: {
              message: {
                actions: {
                  allow: ["send"],
                },
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
