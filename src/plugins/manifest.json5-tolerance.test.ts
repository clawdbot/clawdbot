// Covers JSON5 tolerance in plugin manifest parsing.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMemorySlotDecision } from "./config-state.js";
import { loadPluginManifest } from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-manifest-json5", tempDirs);
}

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it("normalizes static doctor session route-state owners", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "doctor-owners",
        configSchema: { type: "object" },
        sessionRouteStateOwners: [
          {
            id: " demo ",
            label: " Demo owner ",
            providerIds: [" demo ", "", "demo"],
          },
          { id: "blank-list", label: "Blank list", runtimeIds: [" "] },
          { id: " ", label: "Missing id" },
          null,
        ],
      }),
      "utf-8",
    );

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.sessionRouteStateOwners).toEqual([
        {
          id: "demo",
          label: "Demo owner",
          providerIds: ["demo", "demo"],
          runtimeIds: [],
          cliSessionKeys: [],
          authProfilePrefixes: [],
        },
      ]);
    }
  });

  it("uses native JSON parsing for standard JSON manifests", () => {
    const json5Parse = vi.spyOn(JSON5, "parse");
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "strict-json",
        configSchema: { type: "object" },
      }),
      "utf-8",
    );

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    expect(json5Parse).not.toHaveBeenCalled();
  });

  it("reuses unchanged manifest loads within one lifecycle generation", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "cached-json",
        configSchema: { type: "object" },
      }),
      "utf-8",
    );
    const first = loadPluginManifest(dir, false);
    const second = loadPluginManifest(dir, false);

    expect(first.ok).toBe(true);
    expect(second).toBe(first);
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

  it.each([
    {
      name: "a supported memory kind",
      rawKind: "memory",
      expectedKind: "memory",
    },
    {
      name: "a supported context-engine kind",
      rawKind: "context-engine",
      expectedKind: "context-engine",
    },
    {
      name: "both supported kinds in declaration order",
      rawKind: ["context-engine", "memory"],
      expectedKind: ["context-engine", "memory"],
    },
    {
      name: "duplicate memory kinds collapsed into one kind",
      rawKind: ["memory", "memory"],
      expectedKind: "memory",
    },
    {
      name: "duplicate context-engine kinds collapsed into one kind",
      rawKind: ["context-engine", "context-engine"],
      expectedKind: "context-engine",
    },
    {
      name: "supported kinds filtered from invalid and duplicate array entries",
      rawKind: ["memory", "unknown-kind", 42, "memory", "context-engine", null],
      expectedKind: ["memory", "context-engine"],
    },
    {
      name: "a valid memory kind retained alongside invalid entries",
      rawKind: ["unknown-kind", 42, "memory", null],
      expectedKind: "memory",
    },
    {
      name: "an unsupported scalar kind",
      rawKind: "unknown-kind",
      expectedKind: undefined,
    },
    {
      name: "an array containing only unsupported kinds",
      rawKind: ["unknown-kind", 42, null],
      expectedKind: undefined,
    },
  ])("normalizes $name", ({ rawKind, expectedKind }) => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "kind-normalization",
        kind: rawKind,
        configSchema: { type: "object" },
      }),
      "utf-8",
    );

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toEqual(expectedKind);
    }
  });

  it("keeps duplicate memory declarations subject to the exclusive memory slot", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "duplicate-memory",
        kind: ["memory", "memory"],
        configSchema: { type: "object" },
      }),
      "utf-8",
    );

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toBe("memory");
      expect(
        resolveMemorySlotDecision({
          id: result.manifest.id,
          kind: result.manifest.kind,
          slot: "memory-core",
          selectedId: "memory-core",
        }),
      ).toEqual({ enabled: false, reason: 'memory slot set to "memory-core"' });
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

  it("normalizes catalog curation metadata from the manifest", () => {
    const dir = makeTempDir();
    const json5Content = `{
  id: "catalog-plugin",
  catalog: {
    featured: false,
    order: 0,
  },
  configSchema: { type: "object" }
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.catalog).toEqual({ featured: false, order: 0 });
    }
  });

  it("retains static MCP server declarations", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "mcp-app-plugin",
        configSchema: { type: "object" },
        mcpServers: {
          app: {
            transport: "stdio",
            command: "node",
            args: ["./mcp-server.js"],
          },
          invalid: "./not-a-server.json",
        },
      }),
      "utf-8",
    );

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.mcpServers).toEqual({
        app: {
          transport: "stdio",
          command: "node",
          args: ["./mcp-server.js"],
        },
      });
    }
  });

  it("normalizes activation and setup descriptor metadata from the manifest", () => {
    const dir = makeTempDir();
    const json5Content = `{
  id: "openai",
  activation: {
    onStartup: false,
    onProviders: ["openai", "", "openai"],
    onCommands: ["models", ""],
    onChannels: ["web", ""],
    onRoutes: ["gateway-webhook", ""],
    onConfigPaths: ["browser", ""],
    onCapabilities: ["provider", "tool", "wat"]
  },
  cliCommands: [
    { name: "models", description: "Inspect provider models", hasSubcommands: true },
    { name: "bad command", description: "ignored", hasSubcommands: false },
    { name: "models", description: "duplicate", hasSubcommands: false }
  ],
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
        onStartup: false,
        onProviders: ["openai", "openai"],
        onCommands: ["models"],
        onChannels: ["web"],
        onRoutes: ["gateway-webhook"],
        onConfigPaths: ["browser"],
        onCapabilities: ["provider", "tool"],
      });
      expect(result.manifest.cliCommands).toEqual([
        {
          name: "models",
          description: "Inspect provider models",
          hasSubcommands: true,
        },
      ]);
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
});
