/** Tests merging user OpenClaw MCP server config into Claude bundle-MCP overlays. */
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeClaudeBundleManifest } from "../../plugins/bundle-mcp.test-support.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  cliBundleMcpHarness,
  requireMcpConfigPath,
  setupCliBundleMcpTestHarness,
} from "./bundle-mcp.test-support.js";

const authMocks = vi.hoisted(() => ({
  resolveMcpOAuthAccessToken: vi.fn(),
}));

vi.mock("../mcp-oauth.js", () => ({
  resolveMcpOAuthAccessToken: authMocks.resolveMcpOAuthAccessToken,
}));

setupCliBundleMcpTestHarness();

describe("prepareCliBundleMcpConfig user mcp.servers", () => {
  beforeEach(() => {
    authMocks.resolveMcpOAuthAccessToken.mockReset();
  });

  it("merges user-configured mcp.servers from OpenClaw config", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-user-servers-",
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
        plugins: { enabled: false },
        mcp: {
          servers: {
            omi: {
              type: "sse",
              url: "https://api.omi.me/v1/mcp/sse",
              headers: { Authorization: "Bearer test-token" },
            },
          },
        },
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { type?: string; url?: string }>;
    };
    expect(raw.mcpServers?.omi?.type).toBe("sse");
    expect(raw.mcpServers?.omi?.url).toBe("https://api.omi.me/v1/mcp/sse");

    await prepared.cleanup?.();
  });

  it("translates OpenClaw transport field on user mcp.servers into Claude type", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-user-servers-transport-",
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
        plugins: { enabled: false },
        mcp: {
          servers: {
            context7: {
              transport: "streamable-http",
              url: "https://mcp.context7.com/mcp",
              headers: { CONTEXT7_API_KEY: "ctx7sk-test" },
            },
            "omi-sse": {
              transport: "sse",
              url: "https://api.omi.me/v1/mcp/sse",
            },
          },
        },
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { type?: string; transport?: string; url?: string }>;
    };

    expect(raw.mcpServers?.context7?.type).toBe("http");
    expect(raw.mcpServers?.context7?.url).toBe("https://mcp.context7.com/mcp");
    expect(raw.mcpServers?.context7?.transport).toBeUndefined();

    expect(raw.mcpServers?.["omi-sse"]?.type).toBe("sse");
    expect(raw.mcpServers?.["omi-sse"]?.transport).toBeUndefined();

    await prepared.cleanup?.();
  });

  it("preserves explicit type and still strips transport on user mcp.servers", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-user-servers-transport-explicit-",
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
        plugins: { enabled: false },
        mcp: {
          servers: {
            mixed: {
              type: "http",
              transport: "sse",
              url: "https://mcp.example.com/mcp",
            },
          },
        },
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { type?: string; transport?: string }>;
    };

    expect(raw.mcpServers?.mixed?.type).toBe("http");
    expect(raw.mcpServers?.mixed?.transport).toBeUndefined();

    await prepared.cleanup?.();
  });

  it("omits unavailable OAuth servers without blocking the CLI agent", async () => {
    authMocks.resolveMcpOAuthAccessToken.mockRejectedValueOnce(
      new Error('MCP server "gbrain" requires OAuth authorization.'),
    );
    const warn = vi.fn();
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-user-servers-oauth-",
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
        plugins: { enabled: false },
        mcp: {
          servers: {
            gbrain: {
              transport: "streamable-http",
              url: "https://gbrain.example.com/mcp",
              auth: "oauth",
            },
            localTools: {
              transport: "stdio",
              command: "local-tools",
            },
          },
        },
      },
      warn,
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(raw.mcpServers).toStrictEqual({
      localTools: { type: "stdio", command: "local-tools" },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipped unavailable OAuth server gbrain"),
    );

    await prepared.cleanup?.();
  });

  it("user mcp.servers do not override the loopback additionalConfig", async () => {
    // The OpenClaw loopback server is generated runtime state and must win over
    // user config with the same server name.
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-user-servers-loopback-",
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
        plugins: { enabled: false },
        mcp: {
          servers: {
            openclaw: {
              type: "http",
              url: "https://example.com/malicious",
            },
          },
        },
      },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
          },
        },
      },
    });

    const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
    const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
      mcpServers?: Record<string, { url?: string }>;
    };
    expect(raw.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");

    await prepared.cleanup?.();
  });

  it("replaces overlapping bundle server entries with user-configured mcp.servers", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-user-servers-replace-",
    );
    await writeClaudeBundleManifest({
      homeDir: cliBundleMcpHarness.bundleProbeHomeDir,
      pluginId: "omi",
      manifest: { name: "omi" },
    });
    const pluginDir = path.join(
      cliBundleMcpHarness.bundleProbeHomeDir,
      ".openclaw",
      "extensions",
      "omi",
    );
    await fs.writeFile(
      path.join(pluginDir, ".mcp.json"),
      `${JSON.stringify(
        {
          mcpServers: {
            omi: {
              command: process.execPath,
              args: [cliBundleMcpHarness.bundleProbeServerPath],
              env: { BUNDLE_ONLY: "true" },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await withEnvAsync({ HOME: cliBundleMcpHarness.bundleProbeHomeDir }, async () => {
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
              omi: { enabled: true },
            },
          },
          mcp: {
            servers: {
              omi: {
                type: "sse",
                url: "https://api.omi.me/v1/mcp/sse",
                headers: { Authorization: "Bearer test-token" },
              },
            },
          },
        },
      });

      const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
      const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
        mcpServers?: Record<
          string,
          {
            type?: string;
            url?: string;
            command?: string;
            args?: string[];
            env?: Record<string, string>;
          }
        >;
      };
      expect(raw.mcpServers?.omi?.type).toBe("sse");
      expect(raw.mcpServers?.omi?.url).toBe("https://api.omi.me/v1/mcp/sse");
      expect(raw.mcpServers?.omi?.command).toBeUndefined();
      expect(raw.mcpServers?.omi?.args).toBeUndefined();
      expect(raw.mcpServers?.omi?.env).toBeUndefined();

      await prepared.cleanup?.();
    });
  });
});
