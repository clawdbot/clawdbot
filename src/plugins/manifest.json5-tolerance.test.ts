import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginManifest, MAX_PLUGIN_MANIFEST_BYTES } from "./manifest.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-manifest-json5", tempDirs);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("loadPluginManifest JSON5 tolerance", () => {
  it("parses a standard JSON manifest without issues", () => {
    const dir = makeTempDir();
    const manifest = {
      id: "demo",
      configSchema: { type: "object" },
    };
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("demo");
    }
  });

  it("parses a manifest with trailing commas", () => {
    const dir = makeTempDir();
    const json5Content = `{
  "id": "hindsight",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" },
    },
  },
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("hindsight");
    }
  });

  it("parses a manifest with single-line comments", () => {
    const dir = makeTempDir();
    const json5Content = `{
  // Plugin identifier
  "id": "commented-plugin",
  "configSchema": { "type": "object" }
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("commented-plugin");
    }
  });

  it("parses a manifest with unquoted property names", () => {
    const dir = makeTempDir();
    const json5Content = `{
  id: "unquoted-keys",
  configSchema: { type: "object" }
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("unquoted-keys");
    }
  });

  it("normalizes modelSupport metadata from the manifest", () => {
    const dir = makeTempDir();
    const json5Content = `{
  id: "provider-plugin",
  modelSupport: {
    modelPrefixes: ["gpt-", "", "claude-"],
    modelPatterns: ["^o[0-9].*", ""],
  },
  configSchema: { type: "object" }
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.modelSupport).toEqual({
        modelPrefixes: ["gpt-", "claude-"],
        modelPatterns: ["^o[0-9].*"],
      });
    }
  });

  it("normalizes activation and setup descriptor metadata from the manifest", () => {
    const dir = makeTempDir();
    const json5Content = `{
  id: "openai",
  activation: {
    onProviders: ["openai", "", "openai-codex"],
    onCommands: ["models", ""],
    onChannels: ["web", ""],
    onRoutes: ["gateway-webhook", ""],
    onConfigPaths: ["browser", ""],
    onCapabilities: ["provider", "tool", "wat"]
  },
  setup: {
    providers: [
      { id: "openai", authMethods: ["api-key", ""], envVars: ["OPENAI_API_KEY", ""] },
      { id: "", authMethods: ["oauth"] }
    ],
    cliBackends: ["openai-cli", ""],
    configMigrations: ["legacy-openai-auth", ""],
    requiresRuntime: false
  },
  configSchema: { type: "object" }
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.activation).toEqual({
        onProviders: ["openai", "openai-codex"],
        onCommands: ["models"],
        onChannels: ["web"],
        onRoutes: ["gateway-webhook"],
        onConfigPaths: ["browser"],
        onCapabilities: ["provider", "tool"],
      });
      expect(result.manifest.setup).toEqual({
        providers: [
          {
            id: "openai",
            authMethods: ["api-key"],
            envVars: ["OPENAI_API_KEY"],
          },
        ],
        cliBackends: ["openai-cli"],
        configMigrations: ["legacy-openai-auth"],
        requiresRuntime: false,
      });
    }
  });

  it("still rejects completely invalid syntax", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), "not json at all {{{}}", "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("failed to parse plugin manifest");
    }
  });

  it("rejects JSON5 values that parse but are not objects", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), "'just a string'", "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("plugin manifest must be an object");
    }
  });

  it("rejects oversized manifests before parsing", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "too-large",
        configSchema: { type: "object" },
        padding: "x".repeat(MAX_PLUGIN_MANIFEST_BYTES),
      }),
      "utf-8",
    );

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsafe plugin manifest path");
    }
  });
});
