import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../../../plugins/manifest-registry.js";
import {
  collectBundledProviderAllowlistPolicyWarnings,
  collectPluginToolAllowlistWarnings,
} from "./plugin-tool-allowlist-warnings.js";

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

  it("warns when restrictive plugins.allow leaves bundled provider discovery in explicit compat mode", () => {
    const warnings = collectBundledProviderAllowlistPolicyWarnings({
      cfg: {
        plugins: {
          allow: ["telegram"],
          bundledDiscovery: "compat",
        },
      },
    });

    expect(warnings).toEqual([
      '- plugins.allow is restrictive, but bundled provider discovery is still in legacy compatibility mode. Bundled provider plugins can still appear in runtime provider inventories; set plugins.bundledDiscovery to "allowlist" after confirming omitted bundled providers are intentionally blocked.',
    ]);
  });

  it.each([
    { name: "default", plugins: { allow: ["telegram"] } },
    {
      name: "explicit allowlist",
      plugins: { allow: ["telegram"], bundledDiscovery: "allowlist" as const },
    },
  ])(
    "does not warn when bundled provider discovery follows the allowlist ($name)",
    ({ plugins }) => {
      const warnings = collectBundledProviderAllowlistPolicyWarnings({ cfg: { plugins } });

      expect(warnings).toStrictEqual([]);
    },
  );
});
