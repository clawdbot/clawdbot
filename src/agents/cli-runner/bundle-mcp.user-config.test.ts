/** Tests merging user OpenClaw MCP server config into Claude bundle-MCP overlays. */
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeClaudeBundleManifest } from "../../plugins/bundle-mcp.test-support.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { peekSessionMcpRuntime, retireSessionMcpRuntime } from "../agent-bundle-mcp-manager-api.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import {
  cliBundleMcpHarness,
  cliNativeMcpPolicyContext,
  requireMcpConfigPath,
  setupCliBundleMcpTestHarness,
  writeCliMcpPolicyProbeServer,
} from "./bundle-mcp.test-support.js";

const authMocks = vi.hoisted(() => ({
  recordMcpOAuthAuthorizationRequired: vi.fn(),
  resolveMcpOAuthAccessToken: vi.fn(),
}));

vi.mock("../mcp-oauth.js", () => ({
  recordMcpOAuthAuthorizationRequired: authMocks.recordMcpOAuthAuthorizationRequired,
  resolveMcpOAuthAccessToken: authMocks.resolveMcpOAuthAccessToken,
}));

setupCliBundleMcpTestHarness();

async function startOAuthMcpProofServer() {
  const authorizationHeaders: Array<string | undefined> = [];
  const httpServer = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      authorizationHeaders.push(request.headers.authorization);
      if (request.headers.authorization !== "Bearer fresh-token") {
        response.writeHead(401, {
          "www-authenticate":
            'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource"',
        });
        response.end();
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number;
        method?: string;
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "oauth-policy-proof", version: "1.0.0" },
            }
          : {
              tools: [
                {
                  name: "read_docs",
                  description: "Read docs",
                  inputSchema: { type: "object" },
                },
              ],
            };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("OAuth MCP proof server did not acquire a loopback port");
  }
  return {
    authorizationHeaders,
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("prepareCliBundleMcpConfig user mcp.servers", () => {
  beforeEach(() => {
    authMocks.recordMcpOAuthAuthorizationRequired.mockReset();
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
    const serverPath = await writeCliMcpPolicyProbeServer();
    const sessionId = "claude-unavailable-oauth-policy";
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-user-servers-oauth-",
    );
    const config = {
      plugins: { enabled: false },
      tools: { allow: ["localTools__read_docs"] },
      mcp: {
        servers: {
          gbrain: {
            transport: "streamable-http" as const,
            url: "https://gbrain.example.com/mcp",
            auth: "oauth" as const,
          },
          localTools: {
            transport: "stdio" as const,
            command: process.execPath,
            args: [serverPath],
          },
        },
      },
    };

    let prepared: Awaited<ReturnType<typeof prepareCliBundleMcpConfig>> | undefined;
    try {
      prepared = await prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: {
          command: "node",
          args: ["./fake-claude.mjs"],
        },
        workspaceDir,
        config,
        nativeMcpPolicy: cliNativeMcpPolicyContext(config, sessionId),
        warn,
      });

      const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
      const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(Object.keys(raw.mcpServers ?? {})).toEqual(["localTools"]);
      expect([
        ...new Set(
          peekSessionMcpRuntime({ sessionId })
            ?.peekCatalog()
            ?.tools.map((tool) => tool.serverName),
        ),
      ]).toEqual(["localTools"]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("skipped unavailable OAuth server gbrain"),
      );
    } finally {
      await prepared?.cleanup?.();
      await retireSessionMcpRuntime({ sessionId, reason: "test-complete" });
    }
  });

  it("keeps native OAuth refresh available while projecting the child bearer", async () => {
    const proof = await startOAuthMcpProofServer();
    const sessionId = "claude-native-policy-oauth-refresh";
    authMocks.resolveMcpOAuthAccessToken
      .mockResolvedValue("fresh-token")
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("stale-token");
    const config = {
      plugins: { enabled: false },
      tools: { allow: ["docs__read_docs"] },
      mcp: {
        servers: {
          docs: {
            transport: "streamable-http" as const,
            url: proof.url,
            auth: "oauth" as const,
            oauth: { scope: "docs.read" },
          },
        },
      },
    };

    let prepared: Awaited<ReturnType<typeof prepareCliBundleMcpConfig>> | undefined;
    try {
      prepared = await prepareCliBundleMcpConfig({
        enabled: true,
        mode: "claude-config-file",
        backend: { command: "node", args: ["./fake-claude.mjs"] },
        workspaceDir: cliBundleMcpHarness.bundleProbeWorkspaceDir,
        config,
        nativeMcpPolicy: cliNativeMcpPolicyContext(config, sessionId),
      });

      const generatedConfigPath = requireMcpConfigPath(prepared.backend.args);
      const raw = JSON.parse(await fs.readFile(generatedConfigPath, "utf-8")) as {
        mcpServers?: Record<
          string,
          { auth?: string; oauth?: unknown; headers?: Record<string, string> }
        >;
      };
      expect(proof.authorizationHeaders.slice(0, 2)).toEqual([
        "Bearer stale-token",
        "Bearer fresh-token",
      ]);
      expect(
        peekSessionMcpRuntime({ sessionId })
          ?.peekCatalog()
          ?.tools.map((tool) => tool.toolName),
      ).toEqual(["read_docs"]);
      expect(raw.mcpServers?.docs).toMatchObject({
        headers: { Authorization: "Bearer fresh-token" },
      });
      expect(raw.mcpServers?.docs?.auth).toBeUndefined();
      expect(raw.mcpServers?.docs?.oauth).toBeUndefined();
      expect(proof.authorizationHeaders.some((value) => value?.includes("OPENCLAW_MCP_AUTH"))).toBe(
        false,
      );
    } finally {
      await prepared?.cleanup?.();
      await retireSessionMcpRuntime({ sessionId, reason: "test-complete" });
      await proof.close();
    }
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
