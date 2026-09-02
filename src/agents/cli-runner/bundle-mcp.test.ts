/** Tests Claude-style bundle-MCP config-file overlays for CLI backends. */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveBundlePluginRoot,
  writeBundleTextFiles,
  writeClaudeBundleManifest,
} from "../../plugins/bundle-mcp.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { prepareCliBundleMcpCaptureAttempt, prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  cliBundleMcpHarness,
  cliNativeMcpPolicyContext,
  prepareBundleProbeCliConfig,
  requireMcpConfigPath,
  setupCliBundleMcpTestHarness,
  writeCliMcpPolicyProbeServer,
} from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

describe("prepareCliBundleMcpConfig", () => {
  it("disables Claude native web search without bundle MCP", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: false,
      mode: "claude-config-file",
      backend: { command: "claude", args: ["--print"] },
      workspaceDir: "/tmp/openclaw-cli-web-search-disabled",
      toolOverrides: { webSearch: false },
    });

    expect(prepared.backend.args).toEqual(["--print", "--disallowedTools", "WebSearch"]);
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("injects a strict empty --mcp-config overlay for bundle-MCP-enabled backends without servers", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-empty-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir,
      config: { plugins: { enabled: false } },
    });

    expect(prepared.backend.args).toContain("--strict-mcp-config");
    // Even empty overlays force Claude to ignore user/global MCP servers.
    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(raw.mcpServers).toStrictEqual({});

    await prepared.cleanup?.();
  });

  it("serves only the exclusive config, ignoring user and plugin servers", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-exclusive-",
    );
    const userConfig = path.join(workspaceDir, "user-mcp.json");
    await fs.writeFile(
      userConfig,
      `${JSON.stringify({ mcpServers: { user: { command: "node", args: ["user.mjs"] } } })}\n`,
      "utf-8",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs", "--mcp-config", "user-mcp.json"],
      },
      workspaceDir,
      config: { plugins: { enabled: false } },
      exclusiveConfig: {
        mcpServers: { openclaw: { command: "node", args: ["openclaw.mjs"] } },
      },
    });

    expect(prepared.backend.args).toContain("--strict-mcp-config");
    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    expect(Object.keys(raw.mcpServers ?? {})).toEqual(["openclaw"]);
    expect(raw.mcpServers?.openclaw?.args).toEqual(["openclaw.mjs"]);
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);

    await prepared.cleanup?.();
  });

  it("injects a merged --mcp-config overlay for bundle-MCP-enabled backends", async () => {
    const prepared = await prepareBundleProbeCliConfig();

    expect(prepared.backend.args).toContain("--strict-mcp-config");
    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    expect(raw.mcpServers?.bundleProbe?.args).toEqual([
      await fs.realpath(cliBundleMcpHarness.bundleProbeServerPath),
    ]);
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.mcpResumeHash).toMatch(/^[0-9a-f]{64}$/);

    await prepared.cleanup?.();
  });

  it("carries Agent Plugins data-dir and transport contracts into external projections", async () => {
    const pluginId = "agent-cli-projection";
    const pluginRoot = resolveBundlePluginRoot(cliBundleMcpHarness.bundleProbeHomeDir, pluginId);
    await writeBundleTextFiles(pluginRoot, {
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: pluginId,
      }),
      "mcp.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          local: { type: "stdio", command: "node" },
          remote: { type: "streamable-http", url: "https://example.test/mcp" },
          legacy: { type: "sse", url: "https://example.test/sse" },
        },
      }),
    });
    const agentDataDir = path.join(
      cliBundleMcpHarness.bundleProbeHomeDir,
      ".openclaw",
      "plugin-data",
      pluginId,
    );
    const userDataPath = path.join(
      cliBundleMcpHarness.bundleProbeHomeDir,
      "user-data-must-not-exist",
    );
    clearPluginMetadataLifecycleCaches();

    const prepared = await withEnvAsync(
      { HOME: cliBundleMcpHarness.bundleProbeHomeDir },
      async () =>
        await prepareCliBundleMcpConfig({
          enabled: true,
          mode: "gemini-system-settings",
          backend: { command: "gemini" },
          workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
          config: {
            plugins: { entries: { [pluginId]: { enabled: true } } },
            mcp: {
              servers: {
                user: {
                  command: "node",
                  env: { PLUGIN_ROOT: "/user/plugin", PLUGIN_DATA: userDataPath },
                },
              },
            },
          },
        }),
    );

    expect((await fs.stat(agentDataDir)).isDirectory()).toBe(true);
    await expect(fs.stat(userDataPath)).rejects.toMatchObject({ code: "ENOENT" });
    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf8"),
    ) as {
      mcpServers?: Record<string, { type?: string; transport?: string; url?: string }>;
    };
    expect(raw.mcpServers?.remote).toMatchObject({
      type: "http",
      url: "https://example.test/mcp",
    });
    expect(raw.mcpServers?.legacy).toMatchObject({
      type: "sse",
      url: "https://example.test/sse",
    });
    expect(raw.mcpServers?.remote?.transport).toBeUndefined();
    expect(raw.mcpServers?.legacy?.transport).toBeUndefined();
    await prepared.cleanup?.();
    await fs.rm(pluginRoot, { recursive: true, force: true });
    clearPluginMetadataLifecycleCaches();
  });

  it("projects session MCP tool denials into Claude disallowed tools", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-deny-",
    );
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "claude",
        args: ["--disallowedTools", "Bash(rm *)"],
      },
      workspaceDir,
      config: {
        plugins: { enabled: false },
        mcp: { servers: { docs: { command: "node", args: ["docs.mjs"] } } },
      },
      toolOverrides: { mcpToolsDeny: { docs: ["delete_docs"] }, webSearch: false },
    });

    expect(prepared.backend.args).toContain("Bash(rm *),WebSearch,mcp__docs__delete_docs");
    await prepared.cleanup?.();
  });

  it("matches Claude's normalized MCP permission identifiers", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-normalized-deny-",
    );
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "claude", args: ["--print"] },
      workspaceDir,
      config: { plugins: { enabled: false } },
      exclusiveConfig: { mcpServers: { "docs.prod": { command: "node" } } },
      toolOverrides: { mcpToolsDeny: { "docs.prod": ["read.value", "read:value"] } },
    });

    const args = prepared.backend.args?.join(",") ?? "";
    expect(args.match(/mcp__docs_prod__read_value/g) ?? []).toHaveLength(1);
    await prepared.cleanup?.();
  });

  it("projects durable policy into the first Claude process config and argv", async () => {
    const serverPath = await writeCliMcpPolicyProbeServer();
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      tools: { allow: ["docs__*"], deny: ["docs__delete_docs"] },
      mcp: { servers: { docs: { command: process.execPath, args: [serverPath] } } },
    };
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "claude", args: ["--print"] },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      config,
      additionalConfig: {
        mcpServers: { openclaw: { url: "http://127.0.0.1:31783/mcp" } },
      },
      toolOverrides: { mcpToolsDeny: { openclaw: ["message"] } },
      nativeMcpPolicy: cliNativeMcpPolicyContext(config, "claude-policy"),
    });

    const args = prepared.backend.args?.join(",") ?? "";
    expect(args).toContain("mcp__docs__delete_docs");
    expect(args).toContain("mcp__docs__task_docs");
    expect(args).toContain("mcp__docs__app_docs");
    expect(args).toContain("mcp__openclaw__message");
    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, { toolFilter?: unknown }> };
    expect(Object.keys(raw.mcpServers ?? {})).toEqual(["docs", "openclaw"]);
    expect(raw.mcpServers?.docs?.toolFilter).toBeUndefined();
    await prepared.cleanup?.();
  });

  it("hides non-model MCP tools from Claude without an explicit policy", async () => {
    const serverPath = await writeCliMcpPolicyProbeServer();
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      mcp: { servers: { docs: { command: process.execPath, args: [serverPath] } } },
    };
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "claude", args: ["--print"] },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      config,
      nativeMcpPolicy: cliNativeMcpPolicyContext(config, "claude-default-hidden"),
    });

    const args = prepared.backend.args?.join(",") ?? "";
    expect(args).toContain("mcp__docs__app_docs");
    expect(args).toContain("mcp__docs__task_docs");
    expect(args).not.toContain("mcp__docs__read_docs");
    expect(args).not.toContain("mcp__docs__delete_docs");
    await prepared.cleanup?.();
  });

  it("projects configured MCP filters into Claude denials without a global tool policy", async () => {
    const serverPath = await writeCliMcpPolicyProbeServer();
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      mcp: {
        servers: {
          docs: {
            command: process.execPath,
            args: [serverPath],
            toolFilter: { include: ["read_*"] },
          },
        },
      },
    };
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "claude", args: ["--print"] },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      config,
      nativeMcpPolicy: cliNativeMcpPolicyContext(config, "claude-configured-filter"),
    });

    const args = prepared.backend.args?.join(",") ?? "";
    expect(args).toContain("mcp__docs__delete_docs");
    expect(args).toContain("mcp__docs__task_docs");
    expect(args).toContain("mcp__docs__app_docs");
    expect(args).not.toContain("mcp__docs__read_docs");
    await prepared.cleanup?.();
  });

  it("projects an exact runtime cap into Claude before spawn", async () => {
    const serverPath = await writeCliMcpPolicyProbeServer();
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      mcp: { servers: { docs: { command: process.execPath, args: [serverPath] } } },
    };
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "claude", args: ["--print"] },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      config,
      nativeMcpPolicy: {
        ...cliNativeMcpPolicyContext(config, "claude-runtime-cap"),
        runtimeToolsAllow: ["docs__read_docs"],
      },
    });

    const args = prepared.backend.args?.join(",") ?? "";
    expect(args).toContain("mcp__docs__delete_docs");
    expect(args).toContain("mcp__docs__task_docs");
    expect(args).toContain("mcp__docs__app_docs");
    expect(args).not.toContain("mcp__docs__read_docs");
    await prepared.cleanup?.();
  });

  it("omits a fully excluded server while retaining an allowed sibling server", async () => {
    const serverPath = await writeCliMcpPolicyProbeServer();
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      tools: { allow: ["docs__read_docs"] },
      mcp: {
        servers: {
          docs: { command: process.execPath, args: [serverPath] },
          admin: { command: process.execPath, args: [serverPath] },
        },
      },
    };
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "claude", args: ["--print"] },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      config,
      nativeMcpPolicy: cliNativeMcpPolicyContext(config, "claude-server-omission"),
    });
    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };

    expect(Object.keys(raw.mcpServers ?? {})).toEqual(["docs"]);
    await prepared.cleanup?.();
  });

  it("omits every configured MCP server removed by durable policy", async () => {
    const serverPath = await writeCliMcpPolicyProbeServer();
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      tools: { allow: ["missing__tool"] },
      mcp: { servers: { docs: { command: process.execPath, args: [serverPath] } } },
    };
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "claude", args: ["--print"] },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      config,
      nativeMcpPolicy: cliNativeMcpPolicyContext(config, "claude-policy-empty"),
    });
    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(raw.mcpServers).toEqual({});
    await prepared.cleanup?.();
  });

  it("omits a server whose restrictive policy catalog cannot be established", async () => {
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      tools: { deny: ["docs__delete_docs"] },
      mcp: {
        servers: { docs: { command: process.execPath, args: ["-e", "process.exit(1)"] } },
      },
    };
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "claude", args: ["--print"] },
      workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
      config,
      nativeMcpPolicy: cliNativeMcpPolicyContext(config, "claude-policy-catalog-failure"),
    });
    const raw = JSON.parse(
      await fs.readFile(requireMcpConfigPath(prepared.backend.args), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };
    expect(raw.mcpServers).toEqual({});
    await prepared.cleanup?.();
  });

  it("applies server disables to exclusive CLI MCP configs", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: { command: "claude" },
      workspaceDir: "/tmp/openclaw-cli-bundle-mcp-exclusive-disable",
      exclusiveConfig: { mcpServers: { openclaw: { command: "node" } } },
      toolOverrides: { mcpServers: { openclaw: false } },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(raw.mcpServers).toEqual({});
    await prepared.cleanup?.();
  });

  it("strips variadic Claude --mcp-config values and merges every listed config", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-variadic-",
    );
    const firstConfig = path.join(workspaceDir, "first-mcp.json");
    const secondConfig = path.join(workspaceDir, "second-mcp.json");
    await fs.writeFile(
      firstConfig,
      `${JSON.stringify({
        mcpServers: {
          first: { command: "node", args: ["first.mjs"] },
          shared: { command: "node", args: ["old.mjs"] },
        },
      })}\n`,
      "utf-8",
    );
    await fs.writeFile(
      secondConfig,
      `${JSON.stringify({
        mcpServers: {
          second: { command: "node", args: ["second.mjs"] },
          shared: { command: "node", args: ["new.mjs"] },
        },
      })}\n`,
      "utf-8",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: [
          "./fake-claude.mjs",
          "--mcp-config",
          "first-mcp.json",
          "second-mcp.json",
          "--verbose",
        ],
      },
      workspaceDir,
      config: { plugins: { enabled: false } },
    });

    expect(prepared.backend.args).not.toContain("first-mcp.json");
    expect(prepared.backend.args).not.toContain("second-mcp.json");
    expect(prepared.backend.args).toContain("--verbose");
    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    expect(raw.mcpServers?.first?.args).toEqual(["first.mjs"]);
    expect(raw.mcpServers?.second?.args).toEqual(["second.mjs"]);
    expect(raw.mcpServers?.shared?.args).toEqual(["new.mjs"]);

    await prepared.cleanup?.();
  });

  it("merges and strips Claude --mcp-config equals form", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-equals-",
    );
    const configPath = path.join(workspaceDir, "equals-mcp.json");
    await fs.writeFile(
      configPath,
      `${JSON.stringify({
        mcpServers: {
          equals: { command: "node", args: ["equals.mjs"] },
        },
      })}\n`,
      "utf-8",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs", "--mcp-config=equals-mcp.json"],
      },
      workspaceDir,
      config: { plugins: { enabled: false } },
    });

    expect(prepared.backend.args).not.toContain("--mcp-config=equals-mcp.json");
    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    expect(raw.mcpServers?.equals?.args).toEqual(["equals.mjs"]);

    await prepared.cleanup?.();
  });

  it("keeps dash-prefixed args after Claude --mcp-config because they terminate variadic values", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-dash-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs", "--mcp-config", "--verbose", "prompt"],
      },
      workspaceDir,
      config: { plugins: { enabled: false } },
    });

    expect(prepared.backend.args).toContain("--verbose");
    expect(prepared.backend.args).toContain("prompt");
    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(raw.mcpServers).toStrictEqual({});

    await prepared.cleanup?.();
  });

  it("loads workspace bundle MCP plugins from the configured workspace root", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-workspace-root-",
    );
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "workspace-probe");
    // Workspace-local plugins should be resolved relative to workspaceDir, not HOME.
    const serverPath = path.join(pluginRoot, "servers", "probe.mjs");
    await fs.mkdir(path.dirname(serverPath), { recursive: true });
    await fs.writeFile(serverPath, "export {};\n", "utf-8");
    await writeClaudeBundleManifest({
      homeDir: workspaceDir,
      pluginId: "workspace-probe",
      manifest: { name: "workspace-probe" },
    });
    await fs.writeFile(
      path.join(pluginRoot, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            workspaceProbe: {
              command: "node",
              args: ["./servers/probe.mjs"],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir,
      config: {
        plugins: {
          entries: {
            "workspace-probe": { enabled: true },
          },
        },
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    expect(raw.mcpServers?.workspaceProbe?.args).toEqual([await fs.realpath(serverPath)]);

    await prepared.cleanup?.();
  });

  it("merges loopback overlay config with bundle MCP servers", async () => {
    const additionalConfig = {
      mcpServers: {
        openclaw: {
          type: "http",
          url: "http://127.0.0.1:23119/mcp",
          headers: {
            Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            "x-openclaw-cli-capture-key": "${OPENCLAW_MCP_CLI_CAPTURE_KEY}",
          },
        },
      },
    };
    const prepared = await prepareBundleProbeCliConfig({
      additionalConfig,
      env: {
        OPENCLAW_MCP_TOKEN: "lb-tk-123",
        OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
      },
    });
    const otherEnvPrepared = await prepareBundleProbeCliConfig({
      additionalConfig,
      env: {
        OPENCLAW_MCP_TOKEN: "other-loopback-token",
        OPENCLAW_MCP_CLI_CAPTURE_KEY: "",
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(Object.keys(raw.mcpServers ?? {}).toSorted()).toEqual(["bundleProbe", "openclaw"]);
    expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer lb-tk-123");
    expect(raw.mcpServers?.openclaw?.headers?.["x-openclaw-cli-capture-key"]).toBe("");
    await prepareCliBundleMcpCaptureAttempt({
      mode: "claude-config-file",
      backend: prepared.backend,
      env: prepared.env,
      captureKey: "attempt-123",
    });
    const attemptRaw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(attemptRaw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer lb-tk-123");
    expect(attemptRaw.mcpServers?.openclaw?.headers?.["x-openclaw-cli-capture-key"]).toBe(
      "attempt-123",
    );
    expect(prepared.mcpConfigHash).toBe(otherEnvPrepared.mcpConfigHash);
    expect(prepared.mcpResumeHash).toBe(otherEnvPrepared.mcpResumeHash);

    await prepared.cleanup?.();
    await otherEnvPrepared.cleanup?.();
  });

  it("preserves extra env values alongside generated MCP config", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-env-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir,
      config: { plugins: { enabled: false } },
      env: {
        OPENCLAW_MCP_TOKEN: "lb-tk-123",
        OPENCLAW_MCP_SESSION_KEY: "agent:main:telegram:group:chat123",
      },
    });

    expect(prepared.env).toEqual({
      OPENCLAW_MCP_TOKEN: "lb-tk-123",
      OPENCLAW_MCP_SESSION_KEY: "agent:main:telegram:group:chat123",
    });

    await prepared.cleanup?.();
  });

  it("leaves args untouched when bundle MCP is disabled", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: false,
      backend: {
        command: "node",
        args: ["./fake-cli.mjs"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-disabled",
    });

    expect(prepared.backend.args).toEqual(["./fake-cli.mjs"]);
    expect(prepared.cleanup).toBeUndefined();
  });
});
