// Covers hook module path config validation.
import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

describe("config hooks module paths", () => {
  const expectRejectedIssuePath = (config: Record<string, unknown>, expectedPath: string) => {
    const res = validateConfigObjectWithPlugins(config);
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected validation failure");
    }
    expect(res.issues.map((issue) => issue.path)).toContain(expectedPath);
  };

  it("rejects absolute hooks.mappings[].transform.module", () => {
    expectRejectedIssuePath(
      {
        agents: { entries: { openclaw: {} } },
        hooks: {
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              transform: { module: "/tmp/transform.mjs" },
            },
          ],
        },
      },
      "hooks.mappings.0.transform.module",
    );
  });

  it("rejects escaping hooks.mappings[].transform.module", () => {
    expectRejectedIssuePath(
      {
        agents: { entries: { openclaw: {} } },
        hooks: {
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              transform: { module: "../escape.mjs" },
            },
          ],
        },
      },
      "hooks.mappings.0.transform.module",
    );
  });

  it.each([
    ["a former handler registration", [{ event: "command:new", module: "hooks/handler.mjs" }]],
    ["an empty array", []],
    ["a malformed value", "hooks/handler.mjs"],
  ])("rejects retired hooks.internal.handlers for %s", (_label, handlers) => {
    expectRejectedIssuePath(
      {
        agents: { entries: { openclaw: {} } },
        hooks: {
          internal: {
            enabled: true,
            handlers,
          },
        },
      },
      "hooks.internal",
    );
  });

  it("accepts hooks.mappings[].channel runtime plugin ids", () => {
    const res = validateConfigObjectWithPlugins({
      agents: { entries: { openclaw: {} } },
      hooks: {
        mappings: [
          {
            match: { path: "custom" },
            action: "agent",
            channel: "collabchat",
            messageTemplate: "hello",
          },
        ],
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects blank hooks.mappings[].channel values", () => {
    expectRejectedIssuePath(
      {
        agents: { entries: { openclaw: {} } },
        hooks: {
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              channel: "   ",
            },
          ],
        },
      },
      "hooks.mappings.0.channel",
    );
  });
});
