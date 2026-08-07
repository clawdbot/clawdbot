/** Verifies bundle manifest loading and bundled plugin runtime resolution. */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadBundleFixture,
  makeTempDir,
  mkdirSafe,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "./loader.test-fixtures.js";

function expectNoUnwiredBundleDiagnostic(
  registry: ReturnType<typeof loadOpenClawPlugins>,
  pluginId: string,
) {
  expect(
    registry.diagnostics.some(
      (diag) =>
        diag.pluginId === pluginId &&
        diag.message.includes("bundle capability detected but not wired"),
    ),
  ).toBe(false);
}

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

describe("bundle plugins", () => {
  it("reports Codex bundles as loaded bundle plugins without importing runtime code", () => {
    useNoBundledPlugins();
    const workspaceDir = makeTempDir();
    const stateDir = makeTempDir();
    const bundleRoot = path.join(workspaceDir, ".openclaw", "extensions", "sample-bundle");
    mkdirSafe(path.join(bundleRoot, ".codex-plugin"));
    mkdirSafe(path.join(bundleRoot, "skills"));
    fs.writeFileSync(
      path.join(bundleRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "Sample Bundle",
        description: "Codex bundle fixture",
        skills: "skills",
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(bundleRoot, "skills", "SKILL.md"),
      "---\ndescription: fixture\n---\n",
    );

    const registry = withEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
      loadOpenClawPlugins({
        workspaceDir,
        onlyPluginIds: ["sample-bundle"],
        config: {
          plugins: {
            entries: {
              "sample-bundle": {
                enabled: true,
              },
            },
          },
        },
        cache: false,
      }),
    );

    const plugin = registry.plugins.find((entry) => entry.id === "sample-bundle");
    expect(plugin?.status).toBe("loaded");
    expect(plugin?.format).toBe("bundle");
    expect(plugin?.bundleFormat).toBe("codex");
    expect(plugin?.bundleCapabilities).toContain("skills");
  });

  it.each([
    {
      name: "treats Claude command roots and settings as supported bundle surfaces",
      pluginId: "claude-skills",
      expectedFormat: "claude",
      expectedCapabilities: ["skills", "commands", "settings"],
      build: (bundleRoot: string) => {
        mkdirSafe(path.join(bundleRoot, "commands"));
        fs.writeFileSync(
          path.join(bundleRoot, "commands", "review.md"),
          "---\ndescription: fixture\n---\n",
        );
        fs.writeFileSync(
          path.join(bundleRoot, "settings.json"),
          '{"hideThinkingBlock":true}',
          "utf-8",
        );
      },
    },
    {
      name: "treats bundle MCP as a supported bundle surface",
      pluginId: "claude-mcp",
      expectedFormat: "claude",
      expectedCapabilities: ["mcpServers"],
      build: (bundleRoot: string) => {
        mkdirSafe(path.join(bundleRoot, ".claude-plugin"));
        fs.writeFileSync(
          path.join(bundleRoot, ".claude-plugin", "plugin.json"),
          JSON.stringify({
            name: "Claude MCP",
          }),
          "utf-8",
        );
        fs.writeFileSync(
          path.join(bundleRoot, ".mcp.json"),
          JSON.stringify({
            mcpServers: {
              probe: {
                command: "node",
                args: ["./probe.mjs"],
              },
            },
          }),
          "utf-8",
        );
      },
    },
    {
      name: "treats Cursor command roots as supported bundle skill surfaces",
      pluginId: "cursor-skills",
      expectedFormat: "cursor",
      expectedCapabilities: ["skills", "commands"],
      build: (bundleRoot: string) => {
        mkdirSafe(path.join(bundleRoot, ".cursor-plugin"));
        mkdirSafe(path.join(bundleRoot, ".cursor", "commands"));
        fs.writeFileSync(
          path.join(bundleRoot, ".cursor-plugin", "plugin.json"),
          JSON.stringify({
            name: "Cursor Skills",
          }),
          "utf-8",
        );
        fs.writeFileSync(
          path.join(bundleRoot, ".cursor", "commands", "review.md"),
          "---\ndescription: fixture\n---\n",
        );
      },
    },
  ])("$name", ({ pluginId, expectedFormat, expectedCapabilities, build }) => {
    const registry = loadBundleFixture({ pluginId, build });
    const plugin = registry.plugins.find((entry) => entry.id === pluginId);

    expect(plugin?.status).toBe("loaded");
    expect(plugin?.bundleFormat).toBe(expectedFormat);
    expect(plugin?.bundleCapabilities).toEqual(expectedCapabilities);
    expectNoUnwiredBundleDiagnostic(registry, pluginId);
  });

  it("accepts bundle HTTP MCP and warns only for incomplete configs", () => {
    const stateDir = makeTempDir();
    const registry = loadBundleFixture({
      pluginId: "claude-mcp-url",
      env: {
        OPENCLAW_HOME: stateDir,
      },
      build: (bundleRoot) => {
        mkdirSafe(path.join(bundleRoot, ".claude-plugin"));
        fs.writeFileSync(
          path.join(bundleRoot, ".claude-plugin", "plugin.json"),
          JSON.stringify({
            name: "Claude MCP URL",
          }),
          "utf-8",
        );
        fs.writeFileSync(
          path.join(bundleRoot, ".mcp.json"),
          JSON.stringify({
            mcpServers: {
              remoteProbe: {
                transport: "streamable-http",
                url: "http://127.0.0.1:8787/mcp",
              },
              incompleteProbe: {
                transport: "streamable-http",
              },
            },
          }),
          "utf-8",
        );
      },
    });

    const plugin = registry.plugins.find((entry) => entry.id === "claude-mcp-url");
    expect(plugin?.status).toBe("loaded");
    expect(plugin?.bundleCapabilities).toEqual(["mcpServers"]);
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.pluginId === "claude-mcp-url" &&
          diag.message.includes("unsupported transports or incomplete configs") &&
          diag.message.includes("incompleteProbe"),
      ),
    ).toBe(true);
    expect(
      registry.diagnostics.some(
        (diag) => diag.pluginId === "claude-mcp-url" && diag.message.includes("remoteProbe"),
      ),
    ).toBe(false);
  });

  it.each([
    {
      pluginId: "claude-agent-pack",
      bundleFormat: "claude" as const,
      manifestDir: ".claude-plugin",
      agentPath: "agents/reviewer.md",
      name: "reviewer",
      description: "Reviews changes for correctness",
    },
    {
      pluginId: "cursor-agent-pack",
      bundleFormat: "cursor" as const,
      manifestDir: ".cursor-plugin",
      agentPath: ".cursor/agents/explorer.md",
      name: "explorer",
      description: "Maps an unfamiliar repository",
    },
  ])("preserves $bundleFormat bundle agents as metadata", (fixture) => {
    const registry = loadBundleFixture({
      pluginId: fixture.pluginId,
      build: (bundleRoot) => {
        mkdirSafe(path.join(bundleRoot, fixture.manifestDir));
        fs.writeFileSync(
          path.join(bundleRoot, fixture.manifestDir, "plugin.json"),
          JSON.stringify({ name: fixture.pluginId }),
          "utf8",
        );
        mkdirSafe(path.dirname(path.join(bundleRoot, fixture.agentPath)));
        fs.writeFileSync(
          path.join(bundleRoot, fixture.agentPath),
          [
            "---",
            `name: ${fixture.name}`,
            `description: ${fixture.description}`,
            "model: inherit",
            "---",
            "Template prompt body.",
          ].join("\n"),
          "utf8",
        );
      },
    });

    const plugin = registry.plugins.find((entry) => entry.id === fixture.pluginId);
    expect(plugin).toMatchObject({
      bundleFormat: fixture.bundleFormat,
      bundleAgentTemplates: [
        {
          id: `${fixture.pluginId}:${fixture.name}`,
          pluginId: fixture.pluginId,
          sourceFormat: fixture.bundleFormat,
          name: fixture.name,
          description: fixture.description,
          prompt: {
            kind: "file",
            path: fixture.agentPath,
            contentDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
          sourceFilePath: fixture.agentPath,
          model: "inherit",
        },
      ],
    });
  });

  it("keeps loading a bundle when an agent definition is malformed", () => {
    const registry = loadBundleFixture({
      pluginId: "malformed-agent-pack",
      build: (bundleRoot) => {
        mkdirSafe(path.join(bundleRoot, "agents"));
        fs.writeFileSync(
          path.join(bundleRoot, "agents", "broken.md"),
          ["---", "name: broken", "description: [unterminated", "Prompt body."].join("\n"),
          "utf8",
        );
      },
    });

    const plugin = registry.plugins.find((entry) => entry.id === "malformed-agent-pack");
    expect(plugin?.status).toBe("loaded");
    expect(plugin).toMatchObject({ bundleAgentTemplates: [] });
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: "malformed-agent-pack",
        level: "warn",
        message: expect.stringContaining("invalid frontmatter"),
      }),
    );
  });
});
