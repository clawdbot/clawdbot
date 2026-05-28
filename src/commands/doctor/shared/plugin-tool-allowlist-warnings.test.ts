import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.js";
import { collectPluginToolAllowlistWarnings } from "./plugin-tool-allowlist-warnings.js";

const manifestRegistry: PluginManifestRegistry = {
  diagnostics: [],
  plugins: [
    {
      id: "firecrawl",
      channels: [],
      cliBackends: [],
      hooks: [],
      manifestPath: "/virtual/firecrawl/openclaw.plugin.json",
      origin: "bundled",
      providers: [],
      rootDir: "/virtual/firecrawl",
      skills: [],
      source: "/virtual/firecrawl/index.ts",
      contracts: {
        tools: ["firecrawl_search", "firecrawl_scrape"],
      },
    },
    {
      id: "lobster",
      channels: [],
      cliBackends: [],
      hooks: [],
      manifestPath: "/virtual/lobster/openclaw.plugin.json",
      origin: "bundled",
      providers: [],
      rootDir: "/virtual/lobster",
      skills: [],
      source: "/virtual/lobster/index.ts",
    },
  ],
};

describe("collectPluginToolAllowlistWarnings", () => {
  it("warns when tools.allow wildcard is paired with restrictive plugins.allow", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        plugins: { allow: ["telegram"] },
        tools: { allow: ["*"] },
      },
      manifestRegistry,
    });

    expect(warnings).toEqual([
      '- plugins.allow is an exclusive plugin allowlist. tools.allow contains "*", but that wildcard only matches tools from plugins that are loaded; plugin tools outside plugins.allow stay unavailable. Add the required plugin ids to plugins.allow or remove plugins.allow.',
    ]);
  });

  it("warns when an allowlisted tool is owned by a plugin outside plugins.allow", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        plugins: { allow: ["telegram"] },
        tools: { allow: ["firecrawl_search"] },
      },
      manifestRegistry,
    });

    expect(warnings).toEqual([
      '- tools.allow references tool "firecrawl_search", owned by plugin "firecrawl", but plugins.allow does not include the owning plugin. Add "firecrawl" to plugins.allow or remove plugins.allow.',
    ]);
  });

  it("warns when a tool policy references a known plugin outside plugins.allow", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        plugins: { allow: ["telegram"] },
        agents: {
          list: [
            {
              id: "agent-a",
              tools: { alsoAllow: ["lobster"] },
            },
          ],
        },
      },
      manifestRegistry,
    });

    expect(warnings).toEqual([
      '- agents.list[0].tools.alsoAllow references plugin "lobster", but plugins.allow does not include it. Add "lobster" to plugins.allow or remove plugins.allow.',
    ]);
  });

  it("warns when sandbox allowlist hides configured MCP servers", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: {
          servers: {
            gmail: { command: "node", args: ["gmail-server.js"] },
            outlook: { command: "node", args: ["outlook-server.js"] },
          },
        },
        tools: {
          profile: "coding",
          sandbox: {
            tools: {
              alsoAllow: ["web_search", "web_fetch", "memory_search", "memory_get"],
            },
          },
        },
      },
      manifestRegistry,
    });

    expect(warnings).toEqual([
      '- mcp.servers defines 2 MCP servers ("gmail", "outlook"), but tools.sandbox.tools.alsoAllow does not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
    ]);
  });

  it("warns when sandbox allowlist covers only one configured MCP server", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: {
          servers: {
            gmail: { command: "node", args: ["gmail-server.js"] },
            outlook: { command: "node", args: ["outlook-server.js"] },
          },
        },
        tools: {
          sandbox: {
            tools: {
              alsoAllow: ["outlook__*"],
            },
          },
        },
      },
      manifestRegistry,
    });

    expect(warnings).toEqual([
      '- mcp.servers defines 2 MCP servers ("gmail", "outlook"), but tools.sandbox.tools.alsoAllow does not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
    ]);
  });

  it("uses a config-path source label when sandbox allowlist is unset", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
      },
      manifestRegistry,
    });

    expect(warnings).toEqual([
      '- mcp.servers defines 1 MCP server ("outlook"), but tools.sandbox.tools.alsoAllow (unset) does not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
    ]);
  });

  it("does not warn when the global profile blocks MCP tools before sandbox policy", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: {
          profile: "minimal",
          sandbox: { tools: { alsoAllow: ["web_fetch"] } },
        },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("still warns when the profile allows MCP tools but sandbox policy hides them", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: {
          profile: "minimal",
          alsoAllow: ["bundle-mcp"],
          sandbox: { tools: { alsoAllow: ["web_fetch"] } },
        },
      },
      manifestRegistry,
    });

    expect(warnings).toEqual([
      '- mcp.servers defines 1 MCP server ("outlook"), but tools.sandbox.tools.alsoAllow does not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
    ]);
  });

  it("does not warn when the agent profile blocks MCP tools before sandbox policy", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: {
          list: [
            {
              id: "worker",
              sandbox: { mode: "all" },
              tools: {
                profile: "minimal",
                sandbox: { tools: { alsoAllow: ["web_fetch"] } },
              },
            },
          ],
        },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn when the active provider profile blocks MCP tools before sandbox policy", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: {
          byProvider: {
            openai: { profile: "minimal" },
          },
          sandbox: { tools: { alsoAllow: ["web_fetch"] } },
        },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn when the active provider allowlist blocks MCP tools before sandbox policy", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: {
          byProvider: {
            openai: { allow: ["read"] },
          },
          sandbox: { tools: { alsoAllow: ["web_fetch"] } },
        },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("still warns when the active provider allowlist allows MCP tools but sandbox policy hides them", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: {
          byProvider: {
            openai: { allow: ["bundle-mcp"] },
          },
          sandbox: { tools: { alsoAllow: ["web_fetch"] } },
        },
      },
      manifestRegistry,
    });

    expect(warnings).toEqual([
      '- mcp.servers defines 1 MCP server ("outlook"), but tools.sandbox.tools.alsoAllow does not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
    ]);
  });

  it("uses exact provider policy when checking active profiles", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "bedrock/claude-sonnet" },
            sandbox: { mode: "all" },
          },
        },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: {
          byProvider: {
            bedrock: { profile: "minimal" },
            "amazon-bedrock": { profile: "coding" },
          },
          sandbox: { tools: { alsoAllow: ["web_fetch"] } },
        },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("uses plural grammar when multiple sandbox allow sources hide MCP servers", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: {
          defaults: { sandbox: { mode: "all" } },
          list: [
            {
              id: "worker",
              tools: { sandbox: { tools: { alsoAllow: ["web_fetch"] } } },
            },
          ],
        },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: { sandbox: { tools: { alsoAllow: ["web_search"] } } },
      },
      manifestRegistry,
    });

    expect(warnings).toEqual([
      '- mcp.servers defines 1 MCP server ("outlook"), but agents.list[0].tools.sandbox.tools.alsoAllow, tools.sandbox.tools.alsoAllow do not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
    ]);
  });

  it("does not warn for sandboxed MCP servers when bundle-mcp is explicitly allowed", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: { sandbox: { tools: { alsoAllow: ["web_search", "bundle-mcp"] } } },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn when an agent sandbox tools partial override inherits global MCP allow", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: {
          defaults: { sandbox: { mode: "all" } },
          list: [
            {
              id: "worker",
              tools: { sandbox: { tools: { alsoAllow: ["web_fetch"] } } },
            },
          ],
        },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: { sandbox: { tools: { allow: ["bundle-mcp"] } } },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("still warns for inherited allow policy when one agent intentionally denies MCP", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: {
          defaults: { sandbox: { mode: "all" } },
          list: [
            {
              id: "worker",
              tools: { sandbox: { tools: { deny: ["bundle-mcp"] } } },
            },
          ],
        },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: { sandbox: { tools: { alsoAllow: ["web_fetch"] } } },
      },
      manifestRegistry,
    });

    expect(warnings).toEqual([
      '- mcp.servers defines 1 MCP server ("outlook"), but tools.sandbox.tools.alsoAllow does not include "bundle-mcp", "group:plugins", or a matching server-prefixed MCP tool name/glob such as "<server>__*". Sandboxed agents will filter bundled MCP tools before provider requests. Add "bundle-mcp" to tools.sandbox.tools.alsoAllow (or use "group:plugins" / server globs) if those MCP tools should be visible; use tools.sandbox.tools.allow: [] only when you intentionally want no sandbox allow gate.',
    ]);
  });

  it("does not warn for sandboxed MCP servers when group:plugins is explicitly allowed", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: { sandbox: { tools: { alsoAllow: ["group:plugins"] } } },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn for sandboxed MCP servers when a server glob is explicitly allowed", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: { sandbox: { tools: { alsoAllow: ["outlook__*"] } } },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn for sandboxed MCP servers when an exact server tool is explicitly allowed", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: { sandbox: { tools: { alsoAllow: ["outlook__send_mail"] } } },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn when a server glob matches the sanitized MCP server name", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { "Outlook Graph": { command: "node", args: ["outlook-server.js"] } } },
        tools: { sandbox: { tools: { alsoAllow: ["outlook-graph__*"] } } },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn for sandboxed MCP servers when sandbox allow is explicitly allow-all", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: { sandbox: { tools: { allow: [] } } },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn when regular tool policy explicitly denies bundled MCP tools", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: { deny: ["bundle-mcp"] },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn when regular tool allowlist intentionally omits MCP tools", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "all" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: { allow: ["read"] },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn about MCP sandbox allowlists when sandbox mode is off", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        agents: { defaults: { sandbox: { mode: "off" } } },
        mcp: { servers: { outlook: { command: "node", args: ["outlook-server.js"] } } },
        tools: { sandbox: { tools: { alsoAllow: ["web_search"] } } },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn when the owning plugin is allowed", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        plugins: { allow: ["firecrawl"] },
        tools: { allow: ["firecrawl_search"] },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });

  it("does not warn when plugins.allow is not restrictive", () => {
    const warnings = collectPluginToolAllowlistWarnings({
      cfg: {
        tools: { allow: ["*"] },
      },
      manifestRegistry,
    });

    expect(warnings).toStrictEqual([]);
  });
});
