import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

const mocks = vi.hoisted(() => ({
  plugins: [] as PluginManifestRecord[],
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: () => ({ diagnostics: [], plugins: mocks.plugins }),
}));

vi.mock("./plugin-registry-contributions.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({ diagnostics: [], plugins: mocks.plugins }),
}));

vi.mock("./config-state.js", () => ({
  hasExplicitPluginConfig: (plugins?: { entries?: Record<string, unknown> }) =>
    Boolean(plugins?.entries && Object.keys(plugins.entries).length > 0),
  normalizePluginsConfig: (plugins?: unknown) => plugins,
  resolveEffectivePluginActivationState: (params: {
    config?: { entries?: Record<string, { enabled?: boolean }> };
    id: string;
  }) => ({
    activated: params.config?.entries?.[params.id]?.enabled !== false,
  }),
}));

const { loadEnabledClaudeBundleCommands } = await import("./bundle-commands.js");

const tempDirs: string[] = [];

afterEach(async () => {
  mocks.plugins = [];
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function resolveBundlePluginRoot(homeDir: string, pluginId: string) {
  return path.join(homeDir, ".openclaw", "extensions", pluginId);
}

async function writeClaudeBundleCommandFixture(params: {
  homeDir: string;
  pluginId: string;
  commands: Array<{ relativePath: string; contents: string[] }>;
}) {
  const pluginRoot = resolveBundlePluginRoot(params.homeDir, params.pluginId);
  await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: params.pluginId }, null, 2)}\n`,
    "utf-8",
  );
  await Promise.all(
    params.commands.map(async (command) => {
      const filePath = path.join(pluginRoot, command.relativePath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, [...command.contents, ""].join("\n"), "utf-8");
    }),
  );
  mocks.plugins = [
    {
      id: params.pluginId,
      format: "bundle",
      bundleFormat: "claude",
      bundleCapabilities: ["commands"],
      origin: "global",
      rootDir: pluginRoot,
    } as PluginManifestRecord,
  ];
}

function expectEnabledClaudeBundleCommands(
  commands: ReturnType<typeof loadEnabledClaudeBundleCommands>,
  expected: Array<{
    pluginId: string;
    rawName: string;
    description: string;
    promptTemplate: string;
  }>,
) {
  expect(commands).toEqual(
    expect.arrayContaining(expected.map((entry) => expect.objectContaining(entry))),
  );
}

describe("loadEnabledClaudeBundleCommands", () => {
  it("loads enabled Claude bundle markdown commands and skips disabled-model-invocation entries", async () => {
    const env = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);
    try {
      const homeDir = await createTempDir("openclaw-bundle-commands-home-");
      const workspaceDir = await createTempDir("openclaw-bundle-commands-workspace-");
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
      delete process.env.OPENCLAW_HOME;
      delete process.env.OPENCLAW_STATE_DIR;

      await writeClaudeBundleCommandFixture({
        homeDir,
        pluginId: "compound-bundle",
        commands: [
          {
            relativePath: "commands/office-hours.md",
            contents: [
              "---",
              "description: Help with scoping and architecture",
              "---",
              "Give direct engineering advice.",
            ],
          },
          {
            relativePath: "commands/workflows/review.md",
            contents: [
              "---",
              "name: workflows:review",
              "description: Run a structured review",
              "---",
              "Review the code. $ARGUMENTS",
            ],
          },
          {
            relativePath: "commands/disabled.md",
            contents: ["---", "disable-model-invocation: true", "---", "Do not load me."],
          },
        ],
      });

      const commands = loadEnabledClaudeBundleCommands({
        workspaceDir,
        cfg: {
          plugins: {
            entries: { "compound-bundle": { enabled: true } },
          },
        },
      });

      expectEnabledClaudeBundleCommands(commands, [
        {
          pluginId: "compound-bundle",
          rawName: "office-hours",
          description: "Help with scoping and architecture",
          promptTemplate: "Give direct engineering advice.",
        },
        {
          pluginId: "compound-bundle",
          rawName: "workflows:review",
          description: "Run a structured review",
          promptTemplate: "Review the code. $ARGUMENTS",
        },
      ]);
      expect(commands.some((entry) => entry.rawName === "disabled")).toBe(false);
    } finally {
      env.restore();
    }
  });
});
