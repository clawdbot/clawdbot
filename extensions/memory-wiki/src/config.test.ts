// Memory Wiki tests cover config plugin behavior.
import fs from "node:fs";
import path from "node:path";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import {
  DEFAULT_WIKI_RENDER_MODE,
  DEFAULT_WIKI_SEARCH_BACKEND,
  DEFAULT_WIKI_SEARCH_CORPUS,
  DEFAULT_WIKI_VAULT_MODE,
  DEFAULT_WIKI_VAULT_SCOPE,
  memoryWikiConfigSchema,
  resolveDefaultMemoryWikiVaultPath,
  resolveDefaultMemoryWikiVaultRoot,
  resolveMemoryWikiAgentConfig,
  resolveMemoryWikiConfig,
} from "./config.js";

function compileManifestConfigSchema() {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: JsonSchemaObject };
  return (value: unknown) =>
    validateJsonSchemaValue({
      cacheKey: "memory-wiki.manifest.config.test",
      schema: manifest.configSchema,
      value,
      applyDefaults: true,
    }).ok;
}

describe("resolveMemoryWikiConfig", () => {
  it("returns isolated defaults", () => {
    const config = resolveMemoryWikiConfig(undefined, { homedir: "/Users/tester" });

    expect(config.vaultMode).toBe(DEFAULT_WIKI_VAULT_MODE);
    expect(config.vault.scope).toBe(DEFAULT_WIKI_VAULT_SCOPE);
    expect(config.vault.renderMode).toBe(DEFAULT_WIKI_RENDER_MODE);
    expect(config.vault.path).toBe(resolveDefaultMemoryWikiVaultPath("/Users/tester"));
    expect(config.search.backend).toBe(DEFAULT_WIKI_SEARCH_BACKEND);
    expect(config.search.corpus).toBe(DEFAULT_WIKI_SEARCH_CORPUS);
    expect(config.context.includeCompiledDigestPrompt).toBe(false);
  });

  it("expands ~/ paths and preserves explicit modes", () => {
    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "bridge",
        vault: {
          path: "~/vaults/wiki",
          renderMode: "obsidian",
        },
      },
      { homedir: "/Users/tester" },
    );

    expect(config.vaultMode).toBe("bridge");
    expect(config.vault.path).toBe(path.join("/Users/tester", "vaults", "wiki"));
    expect(config.vault.renderMode).toBe("obsidian");
  });

  it("normalizes the bridge artifact toggle", () => {
    const canonical = resolveMemoryWikiConfig({
      bridge: {
        readMemoryArtifacts: false,
      },
    });

    expect(canonical.bridge.readMemoryArtifacts).toBe(false);
  });

  it("resolves normalized agent ids to distinct vault roots", () => {
    const base = resolveMemoryWikiConfig(
      {
        vault: {
          scope: "agent",
          path: "~/vaults/wiki",
        },
      },
      { homedir: "/Users/tester" },
    );
    const appConfig = {
      agents: {
        list: [{ id: "Support Team", default: true }, { id: "Marketing" }],
      },
    } as OpenClawConfig;

    const support = resolveMemoryWikiAgentConfig({
      config: base,
      appConfig,
      agentId: " SUPPORT TEAM ",
    });
    const marketing = resolveMemoryWikiAgentConfig({
      config: base,
      appConfig,
      agentId: "MARKETING",
    });

    expect(base.vault.path).toBe(path.join("/Users/tester", "vaults", "wiki"));
    expect(support).toMatchObject({
      agentId: "support-team",
      vault: { scope: "agent", path: path.join(base.vault.path, "support-team") },
    });
    expect(marketing).toMatchObject({
      agentId: "marketing",
      vault: { scope: "agent", path: path.join(base.vault.path, "marketing") },
    });
    expect(support.vault.path).not.toBe(marketing.vault.path);
  });

  it("uses the wiki root before appending the single configured agent", () => {
    const base = resolveMemoryWikiConfig(
      { vault: { scope: "agent" } },
      { homedir: "/Users/tester" },
    );

    const resolved = resolveMemoryWikiAgentConfig({
      config: base,
      appConfig: { agents: { list: [{ id: "support", default: true }] } },
    });

    expect(base.vault.path).toBe(resolveDefaultMemoryWikiVaultRoot("/Users/tester"));
    expect(resolved.vault.path).toBe(
      path.join(resolveDefaultMemoryWikiVaultRoot("/Users/tester"), "support"),
    );
  });

  it("fails closed when a multi-agent scoped vault has no agent context", () => {
    const config = resolveMemoryWikiConfig({ vault: { scope: "agent" } });
    const appConfig = {
      agents: { list: [{ id: "support", default: true }, { id: "marketing" }] },
    } as OpenClawConfig;

    expect(() => resolveMemoryWikiAgentConfig({ config, appConfig })).toThrow(
      "agentId is required",
    );
  });

  it("fails closed for unknown scoped agents", () => {
    const config = resolveMemoryWikiConfig({ vault: { scope: "agent" } });
    const appConfig = {
      agents: { list: [{ id: "support", default: true }, { id: "marketing" }] },
    } as OpenClawConfig;

    expect(() => resolveMemoryWikiAgentConfig({ config, appConfig, agentId: "finance" })).toThrow(
      "Unknown memory-wiki agentId: finance",
    );
  });

  it("rejects unsafe-local access for agent-scoped vaults", () => {
    const parsed = memoryWikiConfigSchema.safeParse?.({
      vaultMode: "unsafe-local",
      vault: { scope: "agent" },
    });

    expect(parsed?.success).toBe(false);
    if (parsed?.success === false) {
      expect(parsed.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ["vaultMode"],
          message: "vaultMode=unsafe-local cannot be combined with vault.scope=agent",
        }),
      );
    }
  });

  it("rejects the global Obsidian CLI selector for agent-scoped vaults", () => {
    const parsed = memoryWikiConfigSchema.safeParse?.({
      vault: { scope: "agent" },
      obsidian: { useOfficialCli: true },
    });

    expect(parsed?.success).toBe(false);
    if (parsed?.success === false) {
      expect(parsed.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ["obsidian", "useOfficialCli"],
          message: "obsidian.useOfficialCli cannot be enabled with vault.scope=agent",
        }),
      );
    }
  });
});

describe("memory-wiki manifest config schema", () => {
  it("accepts the documented config shape", () => {
    const validate = compileManifestConfigSchema();
    const config = {
      vaultMode: "unsafe-local",
      vault: {
        path: "~/wiki",
        renderMode: "obsidian",
      },
      obsidian: {
        enabled: true,
        useOfficialCli: true,
      },
      bridge: {
        enabled: true,
        readMemoryArtifacts: true,
        followMemoryEvents: true,
      },
      unsafeLocal: {
        allowPrivateMemoryCoreAccess: true,
        paths: ["extensions/memory-core/src"],
      },
      search: {
        backend: "shared",
        corpus: "all",
      },
      context: {
        includeCompiledDigestPrompt: true,
      },
    };

    expect(validate(config)).toBe(true);
  });

  it("rejects unsafe-local access for agent-scoped vaults", () => {
    const validate = compileManifestConfigSchema();

    expect(
      validate({
        vaultMode: "unsafe-local",
        vault: { scope: "agent" },
      }),
    ).toBe(false);
  });

  it("rejects the global Obsidian CLI selector for agent-scoped vaults", () => {
    const validate = compileManifestConfigSchema();

    expect(
      validate({
        vault: { scope: "agent" },
        obsidian: { useOfficialCli: true },
      }),
    ).toBe(false);
  });
});
