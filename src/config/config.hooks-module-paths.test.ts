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
        agents: { list: [{ id: "pi" }] },
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
        agents: { list: [{ id: "pi" }] },
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

  it("rejects absolute hooks.internal.handlers[].module", () => {
    expectRejectedIssuePath(
      {
        agents: { list: [{ id: "pi" }] },
        hooks: {
          internal: {
            enabled: true,
            handlers: [{ event: "command:new", module: "/tmp/handler.mjs" }],
          },
        },
      },
      "hooks.internal.handlers.0.module",
    );
  });

  it("rejects escaping hooks.internal.handlers[].module", () => {
    expectRejectedIssuePath(
      {
        agents: { list: [{ id: "pi" }] },
        hooks: {
          internal: {
            enabled: true,
            handlers: [{ event: "command:new", module: "../handler.mjs" }],
          },
        },
      },
      "hooks.internal.handlers.0.module",
    );
  });

  it("accepts hooks.mappings[].channel runtime plugin ids", () => {
    const res = validateConfigObjectWithPlugins({
      agents: { list: [{ id: "pi" }] },
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
        agents: { list: [{ id: "pi" }] },
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
