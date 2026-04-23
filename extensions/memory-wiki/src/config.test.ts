import fs from "node:fs";
import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import type { JsonSchemaObject } from "../../../src/shared/json-schema.types.js";
import {
  DEFAULT_WIKI_RENDER_MODE,
  DEFAULT_WIKI_SEARCH_BACKEND,
  DEFAULT_WIKI_SEARCH_CORPUS,
  DEFAULT_WIKI_VAULT_MODE,
  resolveDefaultMemoryWikiVaultPath,
  resolveMemoryWikiConfig,
} from "./config.js";

function compileManifestConfigSchema() {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: JsonSchemaObject };
  const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  return ajv.compile(manifest.configSchema);
}

describe("resolveMemoryWikiConfig", () => {
  it("returns isolated defaults", () => {
    const config = resolveMemoryWikiConfig(undefined, { homedir: "/Users/tester" });

    expect(config.vaultMode).toBe(DEFAULT_WIKI_VAULT_MODE);
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
    expect(config.vault.path).toBe("/Users/tester/vaults/wiki");
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
});
