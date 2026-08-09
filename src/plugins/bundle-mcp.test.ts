// Verifies bundled MCP plugin metadata and package output.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import { loadEnabledBundleLspConfig } from "./bundle-lsp.js";
import { loadBundleManifest } from "./bundle-manifest.js";
import { inspectBundleMcpRuntimeSupport, loadEnabledBundleMcpConfig } from "./bundle-mcp.js";
import {
  createEnabledPluginEntries,
  createBundleMcpTempHarness,
  createBundleProbePlugin,
  withBundleHomeEnv,
  writeBundleTextFiles,
  writeClaudeBundleManifest,
  resolveBundlePluginRoot,
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

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
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

const AGENT_PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const AGENT_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

async function writeAgentBundle(params: {
  homeDir: string;
  pluginId: string;
  manifest?: Record<string, unknown>;
  mcp?: unknown;
  textFiles?: Record<string, string>;
}) {
  const pluginRoot = resolveBundlePluginRoot(params.homeDir, params.pluginId);
  await writeBundleTextFiles(pluginRoot, {
    "plugin.json": `${JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: params.pluginId, ...params.manifest }, null, 2)}\n`,
    ...(params.mcp === undefined ? {} : { "mcp.json": `${JSON.stringify(params.mcp, null, 2)}\n` }),
    ...params.textFiles,
  });
  return pluginRoot;
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
        const loadedServer = expectDefined(
          loaded.config.mcpServers.bundleProbe,
          "loaded.config.mcpServers.bundleProbe test invariant",
        );
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

  it("uses a provided manifest registry instead of rediscovering bundle plugins", async () => {
    const homeDir = await tempHarness.createTempDir("openclaw-bundle-mcp-home-");
    const workspaceDir = await tempHarness.createTempDir("openclaw-bundle-mcp-workspace-");
    const { pluginRoot } = await createBundleProbePlugin(homeDir);

    const loaded = loadEnabledBundleMcpConfig({
      workspaceDir,
      cfg: createEnabledBundleConfig(["bundle-probe"]),
      manifestRegistry: {
        plugins: [
          {
            id: "bundle-probe",
            origin: "global",
            format: "bundle",
            bundleFormat: "claude",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: await fs.realpath(pluginRoot),
            source: "test",
            manifestPath: path.join(pluginRoot, ".claude-plugin", "plugin.json"),
          },
        ],
      },
    });

    expectNoDiagnostics(loaded.diagnostics);
    expect(loaded.config.mcpServers.bundleProbe).toMatchObject({
      command: "node",
    });
  });

  it("loads MCP servers declared by an enabled native plugin", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-native-mcp-workspace-");
    const pluginRoot = await tempHarness.createTempDir("openclaw-native-mcp-plugin-");
    const loaded = loadEnabledBundleMcpConfig({
      workspaceDir,
      cfg: createEnabledBundleConfig(["native-mcp"]),
      manifestRegistry: {
        plugins: [
          {
            id: "native-mcp",
            origin: "global",
            format: "openclaw",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: pluginRoot,
            source: path.join(pluginRoot, "index.js"),
            manifestPath: path.join(pluginRoot, "openclaw.plugin.json"),
            mcpServers: {
              app: {
                transport: "stdio",
                command: "node",
                args: ["./mcp-server.js"],
              },
            },
          },
        ],
      },
    });

    expectNoDiagnostics(loaded.diagnostics);
    expect(loaded.config.mcpServers.app).toEqual({
      transport: "stdio",
      command: "node",
      args: [path.join(pluginRoot, "mcp-server.js")],
      cwd: pluginRoot,
    });
  });

  it("skips MCP servers declared by a disabled native plugin", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-native-mcp-workspace-");
    const pluginRoot = await tempHarness.createTempDir("openclaw-native-mcp-plugin-");
    const loaded = loadEnabledBundleMcpConfig({
      workspaceDir,
      cfg: { plugins: { entries: { "native-mcp": { enabled: false } } } },
      manifestRegistry: {
        plugins: [
          {
            id: "native-mcp",
            origin: "global",
            format: "openclaw",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: pluginRoot,
            source: path.join(pluginRoot, "index.js"),
            manifestPath: path.join(pluginRoot, "openclaw.plugin.json"),
            mcpServers: { app: { command: "node", args: ["./mcp-server.js"] } },
          },
        ],
      },
    });

    expectNoDiagnostics(loaded.diagnostics);
    expect(loaded.config.mcpServers).toStrictEqual({});
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

  it("loads Link-style Codex bundle MCP config", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-bundle-link",
      async ({ homeDir, workspaceDir }) => {
        const pluginRoot = resolveBundlePluginRoot(homeDir, "link");
        await writeBundleTextFiles(pluginRoot, {
          ".codex-plugin/plugin.json": `${JSON.stringify(
            {
              name: "link",
              skills: "./skills/",
              mcpServers: "./.mcp.json",
            },
            null,
            2,
          )}\n`,
          ".mcp.json": `${JSON.stringify(
            {
              mcpServers: {
                link: {
                  command: "pnpx",
                  args: ["@stripe/link-cli", "--mcp"],
                },
              },
            },
            null,
            2,
          )}\n`,
        });

        const loaded = loadEnabledBundleMcpConfig({
          workspaceDir,
          cfg: createEnabledBundleConfig(["link"]),
        });
        const loadedServer = loaded.config.mcpServers.link;

        expectNoDiagnostics(loaded.diagnostics);
        expect(isRecord(loadedServer) ? loadedServer.command : undefined).toBe("pnpx");
        expect(getServerArgs(loadedServer)).toEqual(["@stripe/link-cli", "--mcp"]);
        await expectResolvedPathEqual(
          isRecord(loadedServer) ? loadedServer.cwd : undefined,
          pluginRoot,
        );
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

  it("loads Agent Plugins MCP config with placeholders, injected env, and canonical transports", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-agent-bundle-mcp",
      async ({ homeDir, workspaceDir }) => {
        const pluginRoot = await writeAgentBundle({
          homeDir,
          pluginId: "portable-mcp",
          mcp: {
            $schema: AGENT_MCP_SCHEMA,
            mcpServers: {
              local: {
                type: "stdio",
                command: "./bin/server",
                args: ["${PLUGIN_ROOT}/config.json", "${PLUGIN_DATA}/cache"],
                env: {
                  ROOT_COPY: "${PLUGIN_ROOT}",
                  DATA_COPY: "${PLUGIN_DATA}",
                },
                cwd: "${PLUGIN_DATA}",
              },
              remote: {
                type: "streamable-http",
                url: "https://example.test/mcp",
                headers: { Authorization: "Bearer test" },
              },
              legacy: {
                type: "sse",
                url: "https://example.test/sse",
              },
            },
          },
          textFiles: {
            "bin/server": "#!/bin/sh\n",
            "config.json": "{}\n",
          },
        });

        const loaded = loadEnabledBundleMcpConfig({
          workspaceDir,
          cfg: createEnabledBundleConfig(["portable-mcp"]),
        });
        const local = expectDefined(loaded.config.mcpServers.local, "local agent MCP server");
        const remote = expectDefined(loaded.config.mcpServers.remote, "remote agent MCP server");
        const legacy = expectDefined(loaded.config.mcpServers.legacy, "legacy agent MCP server");
        const localEnv = isRecord(local.env) ? local.env : {};
        const localArgs = getServerArgs(local);

        expectNoDiagnostics(loaded.diagnostics);
        expect(local).toMatchObject({ transport: "stdio" });
        expect(local.type).toBeUndefined();
        await expectResolvedPathEqual(local.command, path.join(pluginRoot, "bin", "server"));
        await expectResolvedPathEqual(localArgs?.[0], path.join(pluginRoot, "config.json"));
        expect(localArgs?.[1]).toBe(path.join(String(localEnv.PLUGIN_DATA), "cache"));
        await expectResolvedPathEqual(localEnv.PLUGIN_ROOT, pluginRoot);
        const pluginDataPath = path.join(homeDir, ".openclaw", "plugin-data", "portable-mcp");
        expect(localEnv.PLUGIN_DATA).toBe(pluginDataPath);
        expect(local.cwd).toBe(pluginDataPath);
        expect(loaded.prepareDataDirsByServer).toEqual({
          local: { pluginId: "portable-mcp", dataDir: pluginDataPath },
        });
        await expectPathMissing(pluginDataPath);
        expect(localEnv.ROOT_COPY).toBe(localEnv.PLUGIN_ROOT);
        expect(localEnv.DATA_COPY).toBe(localEnv.PLUGIN_DATA);
        expect(remote).toEqual({
          transport: "streamable-http",
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer test" },
        });
        expect(legacy).toEqual({
          transport: "sse",
          url: "https://example.test/sse",
        });
        expect(
          inspectBundleMcpRuntimeSupport({
            pluginId: "portable-mcp",
            rootDir: pluginRoot,
            bundleFormat: "agent",
          }),
        ).toMatchObject({
          hasSupportedStdioServer: true,
          supportedServerNames: ["local", "remote", "legacy"],
          stdioServerNames: ["local"],
          unsupportedServerNames: [],
        });
      },
    );
  });

  it("resolves Agent Plugins relative cwd from the plugin root and rejects traversal", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-agent-bundle-cwd",
      async ({ homeDir, workspaceDir }) => {
        const pluginRoot = await writeAgentBundle({
          homeDir,
          pluginId: "portable-cwd",
          mcp: {
            $schema: AGENT_MCP_SCHEMA,
            mcpServers: {
              valid: { type: "stdio", command: "node", cwd: "./child" },
              relativeEscape: { type: "stdio", command: "node", cwd: "./../escape" },
              placeholderEscape: {
                type: "stdio",
                command: "node",
                cwd: "${PLUGIN_ROOT}/../escape",
              },
            },
          },
          textFiles: { "child/.keep": "" },
        });
        const rootRealPath = await fs.realpath(pluginRoot);
        const relativeProcessCwd = path.relative(rootRealPath, await fs.realpath(process.cwd()));
        expect(relativeProcessCwd === ".." || relativeProcessCwd.startsWith(`..${path.sep}`)).toBe(
          true,
        );

        const loaded = loadEnabledBundleMcpConfig({
          workspaceDir,
          cfg: createEnabledBundleConfig(["portable-cwd"]),
        });

        expect(Object.keys(loaded.config.mcpServers)).toEqual(["valid"]);
        await expectResolvedPathEqual(
          loaded.config.mcpServers.valid?.cwd,
          path.join(pluginRoot, "child"),
        );
        expect(loaded.diagnostics).toHaveLength(2);
        expect(loaded.diagnostics.map((entry) => entry.message)).toEqual([
          expect.stringContaining('invalid MCP server "relativeEscape"'),
          expect.stringContaining('invalid MCP server "placeholderEscape"'),
        ]);
        expect(loaded.diagnostics.every((entry) => entry.message.includes("cwd must remain"))).toBe(
          true,
        );
      },
    );
  });

  it("ignores dot MCP config and inline MCP fields for Agent Plugins", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-agent-bundle-closed",
      async ({ homeDir, workspaceDir }) => {
        const pluginRoot = await writeAgentBundle({
          homeDir,
          pluginId: "closed-agent",
          manifest: {
            mcpServers: {
              inline: { type: "stdio", command: "node" },
            },
          },
          textFiles: {
            ".mcp.json": JSON.stringify({
              mcpServers: { dotted: { type: "stdio", command: "node" } },
            }),
          },
        });

        const loaded = loadEnabledBundleMcpConfig({
          workspaceDir,
          cfg: createEnabledBundleConfig(["closed-agent"]),
        });

        expectNoDiagnostics(loaded.diagnostics);
        expect(loaded.config.mcpServers).toStrictEqual({});
        await expectPathMissing(path.join(homeDir, ".openclaw", "plugin-data", "closed-agent"));
        expect(await fs.realpath(pluginRoot)).toBeTruthy();
      },
    );
  });

  it("keeps Agent Plugins inspection pure when PLUGIN_DATA collides", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-agent-bundle-data-collision",
      async ({ homeDir, workspaceDir }) => {
        const pluginId = "data-dir-collision";
        const pluginRoot = await writeAgentBundle({
          homeDir,
          pluginId,
          mcp: {
            $schema: AGENT_MCP_SCHEMA,
            mcpServers: {
              local: { type: "stdio", command: "node" },
              remote: { type: "streamable-http", url: "https://example.test/mcp" },
            },
          },
          textFiles: {
            "skills/weather/SKILL.md": "---\nname: weather\ndescription: Weather skill\n---\n",
          },
        });
        const pluginDataPath = path.join(homeDir, ".openclaw", "plugin-data", pluginId);
        await fs.mkdir(path.dirname(pluginDataPath), { recursive: true });
        await fs.writeFile(pluginDataPath, "directory collision", "utf8");

        const loaded = loadEnabledBundleMcpConfig({
          workspaceDir,
          cfg: createEnabledBundleConfig([pluginId]),
        });

        expect(loaded.config.mcpServers).toEqual({
          local: {
            transport: "stdio",
            command: "node",
            cwd: await fs.realpath(pluginRoot),
            env: {
              PLUGIN_ROOT: await fs.realpath(pluginRoot),
              PLUGIN_DATA: pluginDataPath,
            },
          },
          remote: { transport: "streamable-http", url: "https://example.test/mcp" },
        });
        expect(loaded.diagnostics).toStrictEqual([]);
        expect(loaded.prepareDataDirsByServer).toEqual({
          local: { pluginId, dataDir: pluginDataPath },
        });
        expect(
          inspectBundleMcpRuntimeSupport({
            pluginId,
            rootDir: pluginRoot,
            bundleFormat: "agent",
          }),
        ).toMatchObject({
          supportedServerNames: ["local", "remote"],
          unsupportedServerNames: [],
        });
        expect((await fs.stat(pluginDataPath)).isFile()).toBe(true);

        const manifest = loadBundleManifest({ rootDir: pluginRoot, bundleFormat: "agent" });
        expect(manifest.ok).toBe(true);
        if (manifest.ok) {
          expect(manifest.manifest.skills).toEqual(["skills"]);
          expect(manifest.manifest.capabilities).toEqual(
            expect.arrayContaining(["skills", "mcpServers"]),
          );
        }
      },
    );
  });

  it.each([
    { name: "malformed JSON", content: "{" },
    { name: "missing mcpServers", content: JSON.stringify({ $schema: AGENT_MCP_SCHEMA }) },
  ])("isolates Agent Plugins MCP failure for $name", async ({ content }) => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-agent-bundle-invalid",
      async ({ homeDir, workspaceDir }) => {
        const pluginRoot = await writeAgentBundle({
          homeDir,
          pluginId: "invalid-agent-mcp",
        });
        await fs.writeFile(path.join(pluginRoot, "mcp.json"), content, "utf-8");

        const loaded = loadEnabledBundleMcpConfig({
          workspaceDir,
          cfg: createEnabledBundleConfig(["invalid-agent-mcp"]),
        });

        expect(loaded.config.mcpServers).toStrictEqual({});
        expect(loaded.diagnostics).toHaveLength(1);
        expect(loaded.diagnostics[0]?.pluginId).toBe("invalid-agent-mcp");
        expect(loaded.diagnostics[0]?.message).toContain("mcp.json");
      },
    );
  });

  it("skips invalid Agent Plugins MCP entries while retaining valid siblings", async () => {
    await withBundleHomeEnv(
      tempHarness,
      "openclaw-agent-bundle-entry-isolation",
      async ({ homeDir, workspaceDir }) => {
        await writeAgentBundle({
          homeDir,
          pluginId: "isolated-agent-mcp",
          mcp: {
            $schema: AGENT_MCP_SCHEMA,
            mcpServers: {
              valid: { type: "streamable-http", url: "https://example.test/mcp" },
              invalid: {
                type: "stdio",
                command: "node --inspect",
                env: { PLUGIN_ROOT: "override" },
              },
            },
          },
        });

        const loaded = loadEnabledBundleMcpConfig({
          workspaceDir,
          cfg: createEnabledBundleConfig(["isolated-agent-mcp"]),
        });

        expect(loaded.config.mcpServers).toEqual({
          valid: {
            transport: "streamable-http",
            url: "https://example.test/mcp",
          },
        });
        expect(loaded.diagnostics).toHaveLength(1);
        expect(loaded.diagnostics[0]?.message).toContain('invalid MCP server "invalid"');
      },
    );
  });
});
