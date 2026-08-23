// @vitest-environment node
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
        routeId: "connection",
        label: "Gateway Host",
        hash: "#settings-connection-host",
      }),
    ]);
  });

  it("matches schema sections to their owning settings page", () => {
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
      uiHints: { "mcp.servers": { advanced: false } },
    });

    expect(matches).toEqual([
      expect.objectContaining({
        routeId: "mcp",
        label: "MCP",
        search: "?section=mcp",
        hash: "#config-section-mcp",
      }),
    ]);
  });

  it("opens every Memory schema match on the merged Settings tab", () => {
    const memorySchema = {
      type: "object",
      properties: {
        memory: {
          type: "object",
          properties: {
            search: {
              type: "object",
              properties: { embeddingModel: { type: "string", title: "Embedding model" } },
            },
          },
        },
      },
    };
    const uiHints = {
      "memory.search": { advanced: false },
      "memory.search.embeddingModel": { advanced: false },
    };

    const searchOnly = findSettingsSearchBlocks({
      query: "embedding model",
      schema: memorySchema,
      value: {},
      uiHints,
    });
    expect(searchOnly).toEqual([
      expect.objectContaining({
        routeId: "memory",
        pathname: "/settings/memory/settings",
      }),
    ]);

    const sectionWide = findSettingsSearchBlocks({
      query: "memory",
      schema: memorySchema,
      value: {},
      uiHints,
    }).filter((block) => block.routeId === "memory");
    expect(sectionWide).toEqual([
      expect.objectContaining({
        routeId: "memory",
        pathname: "/settings/memory/settings",
        hash: "#config-section-memory",
      }),
    ]);
  });

  it("routes moved static blocks to their dedicated pages", () => {
    const security = findSettingsSearchBlocks({
      query: "exec policy",
      schema: null,
      value: null,
      uiHints: {},
    });
    expect(security).toEqual([expect.objectContaining({ routeId: "security", label: "Security" })]);

    const notifications = findSettingsSearchBlocks({
      query: "push notifications",
      schema: null,
      value: null,
      uiHints: {},
    });
    expect(notifications).toEqual([
      expect.objectContaining({
        routeId: "notifications",
        hash: "#settings-communications-notifications",
      }),
    ]);
  });

  it("routes uncurated schema sections to the Advanced page", () => {
    const matches = findSettingsSearchBlocks({
      query: "secrets",
      schema: {
        type: "object",
        properties: {
          secrets: { type: "object", title: "Secrets" },
        },
      },
      value: {},
      uiHints: {},
    });

    expect(matches).toEqual([
      expect.objectContaining({ routeId: "secrets", label: "Secrets" }),
      expect.objectContaining({
        routeId: "advanced",
        search: "?section=secrets&advanced=1",
        hash: "#config-section-secrets",
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
      uiHints: { "tools.profile": { advanced: false } },
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
      uiHints: { "tools.profile": { advanced: false } },
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
      query: "modelo",
      schema: null,
      value: null,
      uiHints: {},
    });

    expect(matches).toEqual([
      expect.objectContaining({
        routeId: "model-providers",
        hash: "#settings-model-behavior",
      }),
      expect.objectContaining({
        routeId: "appearance",
        hash: "#settings-appearance-sidebar",
      }),
    ]);
  });

  it("finds the active-run follow-up preference by its action", () => {
    const matches = findSettingsSearchBlocks({
      query: "steer",
      schema: null,
      value: null,
      uiHints: {},
    });

    expect(matches).toEqual([
      expect.objectContaining({
        routeId: "appearance",
        label: "Chat",
        hash: "#settings-appearance-chat",
      }),
    ]);
  });

  it.each([
    ["language", "Language", "#settings-language"],
    ["locale", "Language", "#settings-language"],
    ["sidebar", "Sidebar", "#settings-appearance-sidebar"],
    ["live agent activity", "Sidebar", "#settings-appearance-sidebar"],
    ["session observer", "Sidebar", "#settings-appearance-sidebar"],
    ["small model", "Sidebar", "#settings-appearance-sidebar"],
    ["camera", "Chat", "#settings-appearance-chat"],
    ["message width", "Chat", "#settings-appearance-chat"],
    ["centered transcript", "Chat", "#settings-appearance-chat"],
    ["hold microphone", "Chat", "#settings-appearance-chat"],
    ["dictate", "Chat", "#settings-appearance-chat"],
    ["dictation", "Chat", "#settings-appearance-chat"],
  ])("finds the appearance control for %s", (query, label, hash) => {
    const matches = findSettingsSearchBlocks({
      query,
      schema: null,
      value: null,
      uiHints: {},
    });

    expect(matches).toContainEqual(
      expect.objectContaining({
        routeId: "appearance",
        label,
        search: "?section=__appearance__",
        hash,
      }),
    );
  });

  it("routes workspace queries to the sessions-hub pages", () => {
    const matches = findSettingsSearchBlocks({
      query: "worktree",
      schema: null,
      value: null,
      uiHints: {},
    });

    expect(matches).toEqual([
      expect.objectContaining({
        routeId: "worktrees",
        label: "Managed Worktrees",
        hash: "",
      }),
    ]);
  });

  it("routes team secret-store searches to the dedicated page", () => {
    const matches = findSettingsSearchBlocks({
      query: "team store",
      schema: null,
      value: null,
      uiHints: {},
    });

    expect(matches).toEqual([
      expect.objectContaining({ routeId: "secrets", label: "Secrets", hash: "" }),
    ]);
  });

  it("routes profile statistics searches to Usage", () => {
    const matches = findSettingsSearchBlocks({
      query: "usage statistics",
      schema: null,
      value: null,
      uiHints: {},
    });

    expect(matches).toEqual([
      expect.objectContaining({
        routeId: "usage",
        label: "Usage statistics",
        hash: "",
      }),
    ]);
  });

  it("finds archived workspace sessions using translated filter text", async () => {
    await i18n.setLocale("es");

    const matches = findSettingsSearchBlocks({
      query: "archivada",
      schema: null,
      value: null,
      uiHints: {},
    });

    expect(matches).toEqual([
      expect.objectContaining({
        routeId: "sessions",
        hash: "",
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

  it("only exposes the identity block when the connection has an identity", () => {
    const search = (identityAvailable: boolean) =>
      findSettingsSearchBlocks({
        query: "avatar",
        schema: null,
        value: null,
        uiHints: {},
        identityAvailable,
      });

    expect(search(false)).toEqual([]);
    expect(search(true)).toEqual([
      expect.objectContaining({
        routeId: "profile",
        hash: "#settings-profile-identity",
      }),
    ]);
  });
});
