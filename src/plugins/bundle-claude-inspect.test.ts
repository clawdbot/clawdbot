import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import { loadBundleManifest } from "./bundle-manifest.js";
import { inspectBundleMcpRuntimeSupport } from "./bundle-mcp.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

/**
 * Integration test: builds a Claude Code bundle plugin fixture on disk
 * and verifies manifest parsing, capability detection, hook resolution,
 * MCP server discovery, and settings detection all work end-to-end.
 */
describe("Claude bundle plugin inspect integration", () => {
  let rootDir: string;
  const tempDirs: string[] = [];

  function writeFixtureText(relativePath: string, value: string) {
    fs.mkdirSync(path.dirname(path.join(rootDir, relativePath)), { recursive: true });
    fs.writeFileSync(path.join(rootDir, relativePath), value, "utf-8");
  }

  function writeFixtureJson(relativePath: string, value: unknown) {
    writeFixtureText(relativePath, JSON.stringify(value));
  }

  function writeFixtureEntries(
    entries: Readonly<Record<string, string | Record<string, unknown>>>,
  ) {
    Object.entries(entries).forEach(([relativePath, value]) => {
      if (typeof value === "string") {
        writeFixtureText(relativePath, value);
        return;
      }
      writeFixtureJson(relativePath, value);
    });
  }

  function setupClaudeInspectFixture() {
    for (const relativeDir of [
      ".claude-plugin",
      "skill-packs/demo",
      "extra-commands/cmd",
      "hooks",
      "custom-hooks",
      "agents",
      "output-styles",
    ]) {
      fs.mkdirSync(path.join(rootDir, relativeDir), { recursive: true });
    }

    writeFixtureEntries({
      ".claude-plugin/plugin.json": {
        name: "Test Claude Plugin",
        description: "Integration test fixture for Claude bundle inspection",
        version: "1.0.0",
        skills: ["skill-packs"],
        commands: "extra-commands",
        agents: "agents",
        hooks: "custom-hooks",
        mcpServers: ".mcp.json",
        lspServers: ".lsp.json",
        outputStyles: "output-styles",
      },
      "skill-packs/demo/SKILL.md":
        "---\nname: demo\ndescription: A demo skill\n---\nDo something useful.",
      "extra-commands/cmd/SKILL.md":
        "---\nname: cmd\ndescription: A command skill\n---\nRun a command.",
      "hooks/hooks.json": '{"hooks":[]}',
      ".mcp.json": {
        mcpServers: {
          "test-stdio-server": {
            command: "echo",
            args: ["hello"],
          },
          "test-sse-server": {
            url: "http://localhost:3000/sse",
          },
        },
      },
      "settings.json": { thinkingLevel: "high" },
      ".lsp.json": {
        lspServers: {
          "typescript-lsp": {
            command: "typescript-language-server",
            args: ["--stdio"],
          },
        },
      },
    });
  }

  function expectLoadedClaudeManifest() {
    const result = loadBundleManifest({ rootDir, bundleFormat: "claude" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected Claude bundle manifest to load");
    }
    return result.manifest;
  }

  function expectClaudeManifestField(params: {
    field: "skills" | "hooks" | "settingsFiles" | "capabilities";
    expected: readonly string[];
  }) {
    const manifest = expectLoadedClaudeManifest();
    const values = manifest[params.field];
    expect(values).toEqual([...params.expected]);
  }

  function expectNoDiagnostics(diagnostics: unknown[]) {
    expect(diagnostics).toStrictEqual([]);
  }

  function expectBundleRuntimeSupport(params: {
    actual: {
      supportedServerNames: string[];
      unsupportedServerNames: string[];
      diagnostics: unknown[];
    } & Record<string, unknown>;
    supportedServerNames: readonly string[];
    unsupportedServerNames: readonly string[];
    hasSupportedKey: "hasSupportedStdioServer" | "hasStdioServer";
  }) {
    expect(params.actual[params.hasSupportedKey]).toBe(true);
    expect(params.actual.supportedServerNames).toEqual([...params.supportedServerNames]);
    expect(params.actual.unsupportedServerNames).toEqual([...params.unsupportedServerNames]);
    expectNoDiagnostics(params.actual.diagnostics);
  }

  function inspectClaudeBundleRuntimeSupport(kind: "mcp" | "lsp"): {
    supportedServerNames: string[];
    unsupportedServerNames: string[];
    diagnostics: unknown[];
    hasSupportedStdioServer?: boolean;
    hasStdioServer?: boolean;
  } {
    if (kind === "mcp") {
      return inspectBundleMcpRuntimeSupport({
        pluginId: "test-claude-plugin",
        rootDir,
        bundleFormat: "claude",
      });
    }
    return inspectBundleLspRuntimeSupport({
      pluginId: "test-claude-plugin",
      rootDir,
      bundleFormat: "claude",
    });
  }

  beforeAll(() => {
    rootDir = makeTrackedTempDir("openclaw-claude-bundle", tempDirs);
    setupClaudeInspectFixture();
  });

  afterAll(() => {
    cleanupTrackedTempDirs(tempDirs);
  });

  it("loads the full Claude bundle manifest with all capabilities", () => {
    const m = expectLoadedClaudeManifest();
    expect(m).toEqual({
      id: "test-claude-plugin",
      name: "Test Claude Plugin",
      description: "Integration test fixture for Claude bundle inspection",
      version: "1.0.0",
      skills: ["skill-packs", "extra-commands", "agents", "output-styles"],
      settingsFiles: ["settings.json"],
      hooks: ["hooks/hooks.json", "custom-hooks"],
      bundleFormat: "claude",
      capabilities: [
        "skills",
        "commands",
        "agents",
        "hooks",
        "mcpServers",
        "lspServers",
        "outputStyles",
        "settings",
      ],
    });
  });

  it.each([
    {
      name: "resolves skills from skills, commands, and agents paths",
      field: "skills" as const,
      expected: ["skill-packs", "extra-commands", "agents", "output-styles"],
    },
    {
      name: "resolves hooks from default and declared paths",
      field: "hooks" as const,
      expected: ["hooks/hooks.json", "custom-hooks"],
    },
    {
      name: "detects settings files",
      field: "settingsFiles" as const,
      expected: ["settings.json"],
    },
    {
      name: "detects all bundle capabilities",
      field: "capabilities" as const,
      expected: [
        "skills",
        "commands",
        "agents",
        "hooks",
        "mcpServers",
        "lspServers",
        "outputStyles",
        "settings",
      ],
    },
  ] as const)("$name", ({ field, expected }) => {
    expectClaudeManifestField({ field, expected });
  });

  it.each([
    {
      name: "inspects MCP runtime support with supported and unsupported servers",
      kind: "mcp" as const,
      supportedServerNames: ["test-stdio-server"],
      unsupportedServerNames: ["test-sse-server"],
      hasSupportedKey: "hasSupportedStdioServer" as const,
    },
    {
      name: "inspects LSP runtime support with stdio server",
      kind: "lsp" as const,
      supportedServerNames: ["typescript-lsp"],
      unsupportedServerNames: [],
      hasSupportedKey: "hasStdioServer" as const,
    },
  ])("$name", ({ kind, supportedServerNames, unsupportedServerNames, hasSupportedKey }) => {
    expectBundleRuntimeSupport({
      actual: inspectClaudeBundleRuntimeSupport(kind),
      supportedServerNames,
      unsupportedServerNames,
      hasSupportedKey,
    });
  });
});
