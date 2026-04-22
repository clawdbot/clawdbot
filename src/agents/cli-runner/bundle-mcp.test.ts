import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createBundleMcpTempHarness,
  createBundleProbePlugin,
  writeClaudeBundleManifest,
} from "../../plugins/bundle-mcp.test-support.js";
import { captureEnv } from "../../test-utils/env.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

const tempHarness = createBundleMcpTempHarness();
let bundleProbeHomeDir = "";
let bundleProbeWorkspaceDir = "";
let bundleProbeServerPath = "";
let envSnapshot: ReturnType<typeof captureEnv> | undefined;

beforeAll(async () => {
  envSnapshot = captureEnv(["OPENCLAW_BUNDLED_PLUGINS_DIR"]);
  bundleProbeHomeDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-home-");
  bundleProbeWorkspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-workspace-");
  const emptyBundledDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-bundled-");
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = emptyBundledDir;
  ({ serverPath: bundleProbeServerPath } = await createBundleProbePlugin(bundleProbeHomeDir));
});

afterAll(async () => {
  envSnapshot?.restore();
  await tempHarness.cleanup();
});

function createEnabledBundleProbeConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "bundle-probe": { enabled: true },
      },
    },
  };
}

async function prepareBundleProbeCliConfig(params?: {
  additionalConfig?: Parameters<typeof prepareCliBundleMcpConfig>[0]["additionalConfig"];
}) {
  const env = captureEnv(["HOME"]);
  try {
    process.env.HOME = bundleProbeHomeDir;
    return await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "claude-config-file",
      backend: {
        command: "node",
        args: ["./fake-claude.mjs"],
      },
      workspaceDir: bundleProbeWorkspaceDir,
      config: createEnabledBundleProbeConfig(),
      additionalConfig: params?.additionalConfig,
    });
  } finally {
    env.restore();
  }
}

describe("prepareCliBundleMcpConfig", () => {
  it("injects a strict empty --mcp-config overlay for bundle-MCP-enabled backends without servers", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-empty-");

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

    const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
    expect(configFlagIndex).toBeGreaterThanOrEqual(0);
    expect(prepared.backend.args).toContain("--strict-mcp-config");
    const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
    expect(typeof generatedConfigPath).toBe("string");
    const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(raw.mcpServers).toEqual({});

    await prepared.cleanup?.();
  });

  it("injects a merged --mcp-config overlay for bundle-MCP-enabled backends", async () => {
    const prepared = await prepareBundleProbeCliConfig();

    const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
    expect(configFlagIndex).toBeGreaterThanOrEqual(0);
    expect(prepared.backend.args).toContain("--strict-mcp-config");
    const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
    expect(typeof generatedConfigPath).toBe("string");
    const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf-8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    expect(raw.mcpServers?.bundleProbe?.args).toEqual([await fs.realpath(bundleProbeServerPath)]);
    expect(prepared.mcpConfigHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.mcpResumeHash).toMatch(/^[0-9a-f]{64}$/);

    await prepared.cleanup?.();
  });

  it("loads workspace bundle MCP plugins from the configured workspace root", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-workspace-root-");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "workspace-probe");
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

    const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
    const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
    const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf-8")) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    expect(raw.mcpServers?.workspaceProbe?.args).toEqual([await fs.realpath(serverPath)]);

    await prepared.cleanup?.();
  });

  it("merges loopback overlay config with bundle MCP servers", async () => {
    const prepared = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
    });

    const configFlagIndex = prepared.backend.args?.indexOf("--mcp-config") ?? -1;
    const generatedConfigPath = prepared.backend.args?.[configFlagIndex + 1];
    const raw = JSON.parse(await fs.readFile(generatedConfigPath as string, "utf-8")) as {
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(Object.keys(raw.mcpServers ?? {}).toSorted()).toEqual(["bundleProbe", "openclaw"]);
    expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer ${OPENCLAW_MCP_TOKEN}");

    await prepared.cleanup?.();
  });

  it("stabilizes the resume hash when only the OpenClaw loopback port changes", async () => {
    const first = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
    });
    const second = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:24567/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
    });

    expect(first.mcpConfigHash).not.toBe(second.mcpConfigHash);
    expect(first.mcpResumeHash).toBe(second.mcpResumeHash);

    await first.cleanup?.();
    await second.cleanup?.();
  });

  it("changes the resume hash when stable MCP semantics change", async () => {
    const first = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
    });
    const second = await prepareBundleProbeCliConfig({
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/other",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
    });

    expect(first.mcpResumeHash).not.toBe(second.mcpResumeHash);

    await first.cleanup?.();
    await second.cleanup?.();
  });

  it("preserves extra env values alongside generated MCP config", async () => {
    const workspaceDir = await tempHarness.createTempDir("openclaw-cli-bundle-mcp-env-");

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
        OPENCLAW_MCP_TOKEN: "loopback-token-123",
        OPENCLAW_MCP_SESSION_KEY: "agent:main:telegram:group:chat123",
      },
    });

    expect(prepared.env).toEqual({
      OPENCLAW_MCP_TOKEN: "loopback-token-123",
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

  it("injects codex MCP config overrides with env-backed loopback headers", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "codex-config-overrides",
      backend: {
        command: "codex",
        args: ["exec", "--json"],
        resumeArgs: ["exec", "resume", "{sessionId}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-codex",
      config: { plugins: { enabled: false } },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
              "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
            },
          },
        },
      },
    });

    expect(prepared.backend.args).toEqual([
      "exec",
      "--json",
      "-c",
      'mcp_servers={ openclaw = { url = "http://127.0.0.1:23119/mcp", bearer_token_env_var = "OPENCLAW_MCP_TOKEN", env_http_headers = { x-session-key = "OPENCLAW_MCP_SESSION_KEY" } } }',
    ]);
    expect(prepared.backend.resumeArgs).toEqual([
      "exec",
      "resume",
      "{sessionId}",
      "-c",
      'mcp_servers={ openclaw = { url = "http://127.0.0.1:23119/mcp", bearer_token_env_var = "OPENCLAW_MCP_TOKEN", env_http_headers = { x-session-key = "OPENCLAW_MCP_SESSION_KEY" } } }',
    ]);
    expect(prepared.cleanup).toBeUndefined();
  });

  it("writes Gemini system settings for bundle MCP servers", async () => {
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: {
        command: "gemini",
        args: ["--prompt", "{prompt}"],
      },
      workspaceDir: "/tmp/openclaw-bundle-mcp-gemini",
      config: { plugins: { enabled: false } },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
        },
      },
      env: {
        OPENCLAW_MCP_TOKEN: "loopback-token-123",
      },
    });

    expect(prepared.backend.args).toEqual(["--prompt", "{prompt}"]);
    expect(prepared.env?.OPENCLAW_MCP_TOKEN).toBe("loopback-token-123");
    expect(typeof prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe("string");
    const raw = JSON.parse(
      await fs.readFile(prepared.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH as string, "utf-8"),
    ) as {
      mcp?: { allowed?: string[] };
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(raw.mcp?.allowed).toEqual(["openclaw"]);
    expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(raw.mcpServers?.openclaw?.headers?.Authorization).toBe("Bearer loopback-token-123");

    await prepared.cleanup?.();
  });
});
