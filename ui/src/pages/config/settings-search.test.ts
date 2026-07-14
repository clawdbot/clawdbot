import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { findSettingsSearchBlocks } from "./settings-search.ts";

afterEach(async () => {
  await i18n.setLocale("en");
});

describe("findSettingsSearchBlocks", () => {
  it("uses word prefixes instead of arbitrary substrings for short queries", () => {
    const matches = findSettingsSearchBlocks({
      query: "cp",
      schema: {
        type: "object",
        properties: {
          mcp: { type: "object", title: "MCP" },
          acp: { type: "object", title: "ACP" },
        },
      },
      value: {},
      uiHints: {},
    });

    expect(matches).toEqual([
      expect.objectContaining({
        routeId: "config",
        label: "Gateway Host",
        hash: "#settings-general-system",
      }),
    ]);
  });

  it("matches visible quick-setting content and schema sections", () => {
    const matches = findSettingsSearchBlocks({
      query: "mcp",
      schema: {
        type: "object",
        properties: {
          mcp: {
            type: "object",
            properties: {
              servers: { type: "object", title: "Servers" },
            },
          },
        },
      },
      value: { mcp: { servers: {} } },
      uiHints: {},
    });

    expect(matches).toEqual([
      expect.objectContaining({
        routeId: "config",
        label: "Automations",
        hash: "#settings-general-automations",
      }),
      expect.objectContaining({
        routeId: "mcp",
        label: "MCP",
        search: "?section=mcp",
        hash: "#config-section-mcp",
      }),
    ]);
  });

  it("maps a nested schema field to its owning settings page", () => {
    const matches = findSettingsSearchBlocks({
      query: "sandbox access",
      schema: {
        type: "object",
        properties: {
          tools: {
            type: "object",
            properties: {
              profile: {
                type: "string",
                title: "Tool profile",
                description: "Controls sandbox access",
              },
            },
          },
        },
      },
      value: {},
      uiHints: {},
    });

    expect(matches).toEqual([
      {
        routeId: "ai-agents",
        label: "Tools",
        search: "?section=tools",
        hash: "#config-section-tools",
      },
    ]);
  });

  it("preserves nested schema matches for short prefix queries", () => {
    const matches = findSettingsSearchBlocks({
      query: "sa",
      schema: {
        type: "object",
        properties: {
          tools: {
            type: "object",
            properties: {
              profile: {
                type: "string",
                description: "Controls sandbox access",
              },
            },
          },
        },
      },
      value: {},
      uiHints: {},
    });

    expect(matches).toEqual([
      {
        routeId: "ai-agents",
        label: "Tools",
        search: "?section=tools",
        hash: "#config-section-tools",
      },
    ]);
  });

  it("searches and displays static settings blocks in the active locale", async () => {
    await i18n.setLocale("es");

    const matches = findSettingsSearchBlocks({
      query: "apariencia",
      schema: null,
      value: null,
      uiHints: {},
    });

    expect(matches).toEqual([
      expect.objectContaining({
        routeId: "config",
        label: "Apariencia",
        hash: "#settings-general-appearance",
      }),
    ]);
  });

  it("does not create block results for an empty query", () => {
    expect(
      findSettingsSearchBlocks({
        query: "  ",
        schema: null,
        value: null,
        uiHints: {},
      }),
    ).toEqual([]);
  });
});
