import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import { loadEnabledBundleLspConfig } from "./bundle-lsp.js";
import { loadEnabledBundleMcpConfig } from "./bundle-mcp.js";
import {
  createEnabledPluginEntries,
  createBundleMcpTempHarness,
  createBundleProbePlugin,
  withBundleHomeEnv,
  writeClaudeBundleManifest,
} from "./bundle-mcp.test-support.js";

function getServerArgs(value: unknown): unknown[] | undefined {
  return isRecord(value) && Array.isArray(value.args) ? value.args : undefined;
}

function normalizePathForAssertion(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  return path.normalize(value).replace(/\\/g, "/");
}

async function expectResolvedPathEqual(actual: unknown, expected: string): Promise<void> {
  expect(typeof actual).toBe("string");
  if (typeof actual !== "string") {
    return;
  }
  expect(normalizePathForAssertion(await fs.realpath(actual))).toBe(
    normalizePathForAssertion(await fs.realpath(expected)),
  );
}

function expectNoDiagnostics(diagnostics: unknown[]) {
  expect(diagnostics).toStrictEqual([]);
}

const tempHarness = createBundleMcpTempHarness();

afterEach(async () => {
  await tempHarness.cleanup();
});

function createEnabledBundleConfig(pluginIds: string[]): OpenClawConfig {
  return {
    plugins: {
      entries: createEnabledPluginEntries(pluginIds),
    },
  };
}

async function expectInlineBundleMcpServer(params: {
  loadedServer: unknown;
  pluginRoot: string;
  commandRelativePath: string;
  argRelativePaths: readonly string[];
}) {
  const loadedArgs = getServerArgs(params.loadedServer);
  const loadedCommand = isRecord(params.loadedServer) ? params.loadedServer.command : undefined;
  const loadedCwd = isRecord(params.loadedServer) ? params.loadedServer.cwd : undefined;
  const loadedEnv =
    isRecord(params.loadedServer) && isRecord(params.loadedServer.env)
      ? params.loadedServer.env
      : {};

  await expectResolvedPathEqual(loadedCwd, params.pluginRoot);
  expect(typeof loadedCommand).toBe("string");
  expect(loadedArgs).toHaveLength(params.argRelativePaths.length);
  expect(typeof loadedEnv.PLUGIN_ROOT).toBe("string");
  if (typeof loadedCommand !== "string" || typeof loadedCwd !== "string") {
    throw new Error("expected inline bundled MCP server to expose command and cwd");
  }
  expect(normalizePathForAssertion(path.relative(loadedCwd, loadedCommand))).toBe(
    normalizePathForAssertion(params.commandRelativePath),
  );
  expect(
    loadedArgs?.map((entry) =>
      typeof entry === "string"
        ? normalizePathForAssertion(path.relative(loadedCwd, entry))
        : entry,
    ),
  ).toEqual([...params.argRelativePaths]);
  await expectResolvedPathEqual(loadedEnv.PLUGIN_ROOT, params.pluginRoot);
}

describe("loadEnabledBundleMcpConfig", () => {
  it("loads enabled Claude bundle MCP config and absolutizes relative args", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-bundle-mcp",
      async ({ homeDir, workspaceDir }) => {
        const { pluginRoot, serverPath } = await createBundleProbePlugin(homeDir);

        const config: OpenClawConfig = {
          plugins: {
            entries: {
              "bundle-probe": { enabled: true },
            },
          },
        };

        const loaded = loadEnabledBundleMcpConfig({
          workspaceDir,
          cfg: config,
        });
        const resolvedServerPath = await fs.realpath(serverPath);
        const loadedServer = loaded.config.mcpServers.bundleProbe;
        const loadedArgs = getServerArgs(loadedServer);
        const loadedServerPath = typeof loadedArgs?.[0] === "string" ? loadedArgs[0] : undefined;
        const resolvedPluginRoot = await fs.realpath(pluginRoot);

        expectNoDiagnostics(loaded.diagnostics);
        expect(isRecord(loadedServer) ? loadedServer.command : undefined).toBe("node");
        expect(loadedArgs).toHaveLength(1);
        if (!loadedServerPath) {
          throw new Error("expected bundled MCP args to include the server path");
        }
        expect(normalizePathForAssertion(await fs.realpath(loadedServerPath))).toBe(
          normalizePathForAssertion(resolvedServerPath),
        );
        await expectResolvedPathEqual(loadedServer.cwd, resolvedPluginRoot);
      },
    );
  });

  it("merges inline bundle MCP servers and skips disabled bundles", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-bundle-inline",
      async ({ homeDir, workspaceDir }) => {
        await writeClaudeBundleManifest({
          homeDir,
          pluginId: "inline-enabled",
          manifest: {
            name: "inline-enabled",
            mcpServers: {
              enabledProbe: {
                command: "node",
                args: ["./enabled.mjs"],
              },
            },
          },
        });
        await writeClaudeBundleManifest({
          homeDir,
          pluginId: "inline-disabled",
          manifest: {
            name: "inline-disabled",
            mcpServers: {
              disabledProbe: {
                command: "node",
                args: ["./disabled.mjs"],
              },
            },
          },
        });

        const loaded = loadEnabledBundleMcpConfig({
          workspaceDir,
          cfg: {
            plugins: {
              entries: {
                ...createEnabledPluginEntries(["inline-enabled"]),
                "inline-disabled": { enabled: false },
              },
            },
          },
        });

        const enabledProbe = loaded.config.mcpServers.enabledProbe;
        const enabledArgs = getServerArgs(enabledProbe);
        expect(isRecord(enabledProbe) ? enabledProbe.command : undefined).toBe("node");
        expect(enabledArgs).toHaveLength(1);
        expect(typeof enabledArgs?.[0]).toBe("string");
        if (typeof enabledArgs?.[0] !== "string") {
          throw new Error("expected inline MCP enabledProbe args to include enabled.mjs");
        }
        expect(enabledArgs[0]).toContain("enabled.mjs");
        expect(loaded.config.mcpServers.disabledProbe).toBeUndefined();
      },
    );
  });

  it("resolves inline Claude MCP paths from the plugin root and expands CLAUDE_PLUGIN_ROOT", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-bundle-inline-placeholder",
      async ({ homeDir, workspaceDir }) => {
        const pluginRoot = await writeClaudeBundleManifest({
          homeDir,
          pluginId: "inline-claude",
          manifest: {
            name: "inline-claude",
            mcpServers: {
              inlineProbe: {
                command: "${CLAUDE_PLUGIN_ROOT}/bin/server.sh",
                args: ["${CLAUDE_PLUGIN_ROOT}/servers/probe.mjs", "./local-probe.mjs"],
                cwd: "${CLAUDE_PLUGIN_ROOT}",
                env: {
                  PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}",
                },
              },
            },
          },
        });

        const loaded = loadEnabledBundleMcpConfig({
          workspaceDir,
          cfg: createEnabledBundleConfig(["inline-claude"]),
        });
        const loadedServer = loaded.config.mcpServers.inlineProbe;

        expectNoDiagnostics(loaded.diagnostics);
        await expectInlineBundleMcpServer({
          loadedServer,
          pluginRoot,
          commandRelativePath: path.join("bin", "server.sh"),
          argRelativePaths: [
            normalizePathForAssertion(path.join("servers", "probe.mjs"))!,
            normalizePathForAssertion("local-probe.mjs")!,
          ],
        });
      },
    );
  });

  it("reports malformed file-backed MCP configs instead of silently dropping servers", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-bundle-malformed-mcp",
      async ({ homeDir, workspaceDir }) => {
        const pluginRoot = await writeClaudeBundleManifest({
          homeDir,
          pluginId: "malformed-mcp",
          manifest: {
            name: "malformed-mcp",
            mcpServers: ".mcp.json",
          },
        });
        await fs.writeFile(path.join(pluginRoot, ".mcp.json"), "{", "utf-8");

        const loaded = loadEnabledBundleMcpConfig({
          workspaceDir,
          cfg: createEnabledBundleConfig(["malformed-mcp"]),
        });

        expect(loaded.config.mcpServers).toStrictEqual({});
        expect(loaded.diagnostics).toHaveLength(1);
        expect(loaded.diagnostics[0]?.pluginId).toBe("malformed-mcp");
        expect(loaded.diagnostics[0]?.message).toContain("unable to read .mcp.json");
      },
    );
  });

  it("reports malformed file-backed LSP configs instead of silently dropping servers", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-bundle-malformed-lsp",
      async ({ homeDir, workspaceDir }) => {
        const pluginRoot = await writeClaudeBundleManifest({
          homeDir,
          pluginId: "malformed-lsp",
          manifest: {
            name: "malformed-lsp",
            lspServers: ".lsp.json",
          },
        });
        await fs.writeFile(path.join(pluginRoot, ".lsp.json"), "{", "utf-8");

        const loaded = loadEnabledBundleLspConfig({
          workspaceDir,
          cfg: createEnabledBundleConfig(["malformed-lsp"]),
        });

        expect(loaded.config.lspServers).toStrictEqual({});
        expect(loaded.diagnostics).toHaveLength(1);
        expect(loaded.diagnostics[0]?.pluginId).toBe("malformed-lsp");
        expect(loaded.diagnostics[0]?.message).toContain("unable to read .lsp.json");
      },
    );
  });
});
