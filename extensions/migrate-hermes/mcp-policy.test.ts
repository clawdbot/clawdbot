import { describe, expect, it } from "vitest";
import { buildConfigItems } from "./config.js";
import { makeContext } from "./test/provider-helpers.js";

const ctx = makeContext({ source: "/hermes", stateDir: "/state", workspaceDir: "/workspace" });

describe("Hermes MCP policy migration", () => {
  it.each([
    [false, false, { exclude: ["*"] }],
    [false, true, { include: ["prompts_list", "prompts_get"] }],
    [true, false, { include: ["resources_list", "resources_read"] }],
    [true, true, { include: ["resources_list", "resources_read", "prompts_list", "prompts_get"] }],
  ])(
    "preserves an empty native allowlist with resources=%s and prompts=%s",
    (resources, prompts, toolFilter) => {
      const items = buildConfigItems({
        ctx,
        config: {
          mcp_servers: {
            acme: { command: "acme-mcp", tools: { include: [], resources, prompts } },
          },
        },
      });
      expect(items.find((item) => item.id === "config:mcp-server:acme")?.details?.value).toEqual({
        acme: { command: "acme-mcp", toolFilter },
      });
    },
  );

  it("preserves an empty string native allowlist", () => {
    const items = buildConfigItems({
      ctx,
      config: {
        mcp_servers: {
          acme: {
            command: "acme-mcp",
            tools: { include: "", resources: false, prompts: false },
          },
        },
      },
    });
    expect(items.find((item) => item.id === "config:mcp-server:acme")?.details?.value).toEqual({
      acme: { command: "acme-mcp", toolFilter: { exclude: ["*"] } },
    });
  });

  it.each(["delete_?", "delete_[ab]"])(
    "requires review before activating an unsupported exclusion %s",
    (pattern) => {
      const items = buildConfigItems({
        ctx,
        config: { mcp_servers: { acme: { command: "acme-mcp", tools: { exclude: [pattern] } } } },
      });
      expect(
        items.find((item) => item.id === "config:mcp-server:acme")?.details?.value,
      ).toMatchObject({
        acme: { enabled: false },
      });
      expect(
        items.find((item) => item.id === "manual:mcp-server-tool-patterns:acme"),
      ).toMatchObject({
        kind: "manual",
        message: expect.stringContaining("disabled"),
      });
    },
  );

  it("keeps the supported subset of an include policy without broadening its tool surface", () => {
    const items = buildConfigItems({
      ctx,
      config: {
        mcp_servers: {
          acme: {
            command: "acme-mcp",
            tools: {
              include: ["read_*", "find_?"],
              exclude: ["delete_?"],
              resources: false,
              prompts: false,
            },
          },
        },
      },
    });
    expect(items.find((item) => item.id === "config:mcp-server:acme")?.details?.value).toEqual({
      acme: { command: "acme-mcp", toolFilter: { include: ["read_*"] } },
    });
    expect(items.find((item) => item.id === "manual:mcp-server-tool-patterns:acme")?.kind).toBe(
      "manual",
    );
  });
});
