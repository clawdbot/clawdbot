// Codex tests cover thread lifecycle.user mcp servers plugin behavior.
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hashCodexAppServerBindingFingerprint,
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  resetCodexTestBindingStore,
  seedCodexTestBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  createAppServerOptions,
  createParams,
  resetThreadLifecycleTestFixtures,
  startOrResumeThread,
  threadResumeResult,
  threadStartResult,
} from "./thread-lifecycle.test-fixtures.js";

const activeHttpServers = new Set<http.Server>();

async function startPolicyHttpServer(): Promise<string> {
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      if (!body) {
        response.writeHead(202).end();
        return;
      }
      const message = JSON.parse(body) as {
        id?: string | number;
        method?: string;
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "policy-http-probe", version: "1" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  { name: "read_docs", description: "read", inputSchema: { type: "object" } },
                ],
              }
            : {};
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  activeHttpServers.add(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback MCP server address");
  }
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function writePolicyProbeServer(dir: string): Promise<string> {
  const filePath = path.join(dir, "policy-probe.mjs");
  await fs.writeFile(
    filePath,
    `import readline from "node:readline";
import { appendFileSync } from "node:fs";
if (process.env.OPENCLAW_POLICY_PROBE_STARTED) appendFileSync(process.env.OPENCLAW_POLICY_PROBE_STARTED, "started\\n");
const lines = readline.createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "policy-probe", version: "1" } });
  if (message.method === "tools/list") send(message.id, { tools: [
    { name: "read_docs", description: "read", inputSchema: { type: "object" } },
    { name: "delete_docs", description: "delete", inputSchema: { type: "object" } },
    { name: "task_docs", description: "task", inputSchema: { type: "object" }, execution: { taskSupport: "required" } },
    { name: "app_docs", description: "app", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } }
  ] });
});
`,
    "utf-8",
  );
  return filePath;
}

describe("startOrResumeThread — user mcp.servers projection (regression: #80814)", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-80814-"));
    // Bindings are keyed by session identity, not tempDir, so sibling tests
    // would otherwise leak resumable threads into fresh-start expectations.
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    resetThreadLifecycleTestFixtures();
    await Promise.all(
      [...activeHttpServers].map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    activeHttpServers.clear();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("projects cfg.mcp.servers into the thread/start config patch under mcp_servers", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const serverPath = await writePolicyProbeServer(tempDir);
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, {
        mcp: {
          servers: {
            docs: {
              transport: "stdio",
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      } as unknown as EmbeddedRunAttemptParams["config"]),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const startCall = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startCall?.[1] as { config?: { mcp_servers?: Record<string, unknown> } };
    expect(startParams?.config?.mcp_servers).toBeDefined();
    expect(startParams.config!.mcp_servers).toMatchObject({
      docs: {
        command: process.execPath,
        args: [serverPath],
        enabled_tools: ["delete_docs", "read_docs"],
        disabled_tools: ["app_docs", "task_docs"],
      },
    });
  });

  it("projects wildcard filters as exact names before thread/start and thread/resume", async () => {
    const sessionFile = path.join(tempDir, "policy-session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const workspaceDir = path.join(tempDir, "workspace");
    const serverPath = await writePolicyProbeServer(tempDir);
    const config: EmbeddedRunAttemptParams["config"] = {
      tools: { allow: ["docs__*"] },
      mcp: {
        servers: {
          docs: {
            transport: "stdio",
            command: process.execPath,
            args: [serverPath],
            toolFilter: { exclude: ["delete_*"] },
          },
        },
      },
    };
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-policy");
      }
      if (method === "thread/resume") {
        return threadResumeResult("thread-policy");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const run = async () =>
      await startOrResumeThread({
        client: { request } as never,
        params: createParams(sessionFile, workspaceDir, config),
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createAppServerOptions(),
      });

    await run();
    await run();

    for (const method of ["thread/start", "thread/resume"]) {
      const call = request.mock.calls.find(([candidate]) => candidate === method);
      const callParams = call?.[1] as {
        config?: {
          mcp_servers?: { docs?: { enabled_tools?: string[]; disabled_tools?: string[] } };
        };
      };
      expect(callParams?.config?.mcp_servers?.docs).toMatchObject({
        enabled_tools: ["read_docs"],
        disabled_tools: ["app_docs", "delete_docs", "task_docs"],
      });
      expect(JSON.stringify(callParams?.config?.mcp_servers?.docs)).not.toContain("delete_*");
    }
  });

  it("keeps session MCP denials additive in thread/start before the turn", async () => {
    const sessionFile = path.join(tempDir, "policy-session-override.jsonl");
    registerCodexTestSessionIdentity(
      sessionFile,
      "session-override",
      "agent:main:session-override",
    );
    const workspaceDir = path.join(tempDir, "workspace-override");
    const serverPath = await writePolicyProbeServer(tempDir);
    const config: EmbeddedRunAttemptParams["config"] = {
      tools: { allow: ["docs__*"] },
      mcp: {
        servers: {
          docs: { transport: "stdio", command: process.execPath, args: [serverPath] },
        },
      },
    };
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-session-override");
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const run: EmbeddedRunAttemptParams = {
      ...createParams(sessionFile, workspaceDir, config),
      toolOverrides: { mcpToolsDeny: { docs: ["delete_docs"] } },
    };

    await startOrResumeThread({
      client: { request } as never,
      params: run,
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const callParams = request.mock.calls[0]?.[1] as {
      config?: { mcp_servers?: { docs?: { enabled_tools?: string[]; disabled_tools?: string[] } } };
    };
    expect(callParams.config?.mcp_servers?.docs).toMatchObject({
      enabled_tools: ["read_docs"],
      disabled_tools: ["app_docs", "delete_docs", "task_docs"],
    });
  });

  it("does not start an MCP server scoped to another Codex agent", async () => {
    const sessionFile = path.join(tempDir, "agent-scope-session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "scope-session", "agent:main:scope-session");
    const workspaceDir = path.join(tempDir, "workspace-scope");
    const serverPath = await writePolicyProbeServer(tempDir);
    const startedPath = path.join(tempDir, "excluded-server-started");
    const config: EmbeddedRunAttemptParams["config"] = {
      tools: { deny: ["docs__delete_docs"] },
      mcp: {
        servers: {
          docs: {
            transport: "stdio",
            command: process.execPath,
            args: [serverPath],
            env: { OPENCLAW_POLICY_PROBE_STARTED: startedPath },
            codex: { agents: ["worker"] },
          },
        },
      },
    };
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-agent-scope");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, config),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    await expect(fs.access(startedPath)).rejects.toMatchObject({ code: "ENOENT" });
    const callParams = request.mock.calls[0]?.[1] as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    expect(callParams.config?.mcp_servers?.docs).toBeUndefined();
  });

  it("stores large user MCP server fingerprints as bounded hashes", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const workspaceDir = path.join(tempDir, "workspace");
    const serverPath = await writePolicyProbeServer(tempDir);
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, {
        mcp: {
          servers: {
            server_large: {
              transport: "stdio",
              command: process.execPath,
              args: [serverPath, "--description", "x".repeat(60_000)],
            },
          },
        },
      } as unknown as EmbeddedRunAttemptParams["config"]),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const binding = await readCodexAppServerBinding(sessionFile);
    expect(binding?.userMcpServersFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(binding?.userMcpServersFingerprint?.length).toBe(71);
    expect(binding?.userMcpServersFingerprint).not.toContain("x".repeat(100));
  });

  it.each(["raw", "doctor-hashed"] as const)(
    "restarts beta5 user MCP bindings stored as %s fingerprints before converging",
    async (legacyForm) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
      const workspaceDir = path.join(tempDir, "workspace");
      const authorization = "Bearer beta5-access-token";
      const url = await startPolicyHttpServer();
      const config = {
        mcp: {
          servers: {
            ducktape: {
              transport: "streamable-http",
              url,
              headers: {
                Authorization: authorization,
                "x-tenant": "keep",
              },
            },
          },
        },
      } as unknown as EmbeddedRunAttemptParams["config"];
      const request = vi.fn(async (method: string, _params: unknown) => {
        if (method === "thread/start") {
          return threadStartResult("thread-beta5");
        }
        if (method === "thread/resume") {
          return threadResumeResult("thread-beta5");
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const run = () =>
        startOrResumeThread({
          client: { request } as never,
          params: createParams(sessionFile, workspaceDir, config),
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createAppServerOptions(),
        });

      await run();
      const currentBinding = await readCodexAppServerBinding(sessionFile);
      expect(currentBinding).toBeDefined();

      const legacyFingerprint = JSON.stringify({
        mcp_servers: {
          ducktape: {
            http_headers: {
              Authorization: authorization,
              "x-tenant": "keep",
            },
            url,
          },
        },
      });
      seedCodexTestBinding(sessionFile, {
        ...currentBinding!,
        userMcpServersFingerprint:
          legacyForm === "raw"
            ? legacyFingerprint
            : hashCodexAppServerBindingFingerprint(legacyFingerprint),
      });

      request.mockClear();
      await run();
      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
      const convergedBinding = await readCodexAppServerBinding(sessionFile);
      expect(convergedBinding?.userMcpServersFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(convergedBinding?.userMcpServersFingerprint).not.toContain("beta5-access-token");
      expect(convergedBinding?.userMcpServersFingerprint).not.toBe(legacyFingerprint);
      expect(convergedBinding?.userMcpServersFingerprint).not.toBe(
        hashCodexAppServerBindingFingerprint(legacyFingerprint),
      );

      request.mockClear();
      await run();
      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    },
  );

  it("projects only Codex user MCP servers scoped to the current agent", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:atlas:session-1");
    const workspaceDir = path.join(tempDir, "workspace");
    const url = await startPolicyHttpServer();
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: {
        ...createParams(sessionFile, workspaceDir, {
          mcp: {
            servers: {
              atlas: {
                transport: "streamable-http",
                url,
                codex: {
                  agents: ["atlas"],
                  defaultToolsApprovalMode: "approve",
                },
              },
              apolo: {
                transport: "streamable-http",
                url,
                codex: {
                  agents: ["apolo"],
                  defaultToolsApprovalMode: "approve",
                },
              },
            },
          },
        } as unknown as EmbeddedRunAttemptParams["config"]),
        // Explicit multi-agent ownership (#114388): the session key owner must
        // match the explicit agentId below.
        sessionKey: "agent:atlas:session-1",
      },
      agentId: "atlas",
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const startCall = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startCall?.[1] as { config?: { mcp_servers?: Record<string, unknown> } };
    expect(startParams?.config?.mcp_servers).toStrictEqual({
      atlas: {
        url,
        default_tools_approval_mode: "approve",
        enabled_tools: ["read_docs"],
      },
    });
  });

  it("omits mcp_servers from the start config when cfg has no user MCP servers", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const startCall = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startCall?.[1] as { config?: { mcp_servers?: Record<string, unknown> } };
    expect(startParams?.config?.mcp_servers).toBeUndefined();
  });

  it("omits user MCP servers when runtime policy disables native tool surfaces", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, {
        mcp: {
          servers: {
            notes: {
              transport: "stdio",
              command: "node",
              args: ["/opt/notes-mcp/dist/index.js"],
            },
          },
        },
      } as unknown as EmbeddedRunAttemptParams["config"]),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    });

    const startCall = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startCall?.[1] as { config?: { mcp_servers?: Record<string, unknown> } };
    expect(startParams?.config?.mcp_servers).toBeUndefined();
  });

  it("starts a new thread when an existing binding lacks the matching user MCP fingerprint", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const serverPath = await writePolicyProbeServer(tempDir);

    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-existing",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
    });

    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-restarted");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, {
        mcp: {
          servers: {
            notes: {
              transport: "stdio",
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      } as unknown as EmbeddedRunAttemptParams["config"]),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    expect(request.mock.calls.some(([method]) => method === "thread/resume")).toBe(false);
    const startCall = request.mock.calls.find(([method]) => method === "thread/start");
    const startParams = startCall?.[1] as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    expect(startParams?.config?.mcp_servers).toBeDefined();
    expect(startParams.config!.mcp_servers).toMatchObject({
      notes: { command: process.execPath, args: [serverPath] },
    });
  });

  it("does not resume an existing native thread when runtime policy disables native tools", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-native",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
    });
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-restricted");
      }
      if (method === "thread/resume") {
        return threadResumeResult("thread-native");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const startParams = request.mock.calls[0]?.[1] as {
      environments?: unknown[];
      config?: {
        "features.code_mode"?: boolean;
        "features.code_mode_only"?: boolean;
        mcp_servers?: Record<string, unknown>;
      };
    };
    expect(startParams?.environments).toEqual([]);
    expect(startParams?.config?.["features.code_mode"]).toBe(false);
    expect(startParams?.config?.["features.code_mode_only"]).toBe(false);
    expect(startParams?.config?.mcp_servers).toBeUndefined();
    const preservedBinding = await readCodexAppServerBinding(sessionFile);
    expect(preservedBinding?.threadId).toBe("thread-native");
  });

  it("preserves MCP-mismatched bindings across transient native-tool-disabled turns", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-native",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      mcpServersFingerprint: "mcp-v1",
    });
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-restricted");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      mcpServersFingerprint: undefined,
      mcpServersFingerprintEvaluated: true,
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const startParams = request.mock.calls[0]?.[1] as {
      config?: {
        "features.code_mode"?: boolean;
        mcp_servers?: Record<string, unknown>;
      };
    };
    expect(startParams?.config?.["features.code_mode"]).toBe(false);
    expect(startParams?.config?.mcp_servers).toBeUndefined();
    const preservedBinding = await readCodexAppServerBinding(sessionFile);
    expect(preservedBinding?.threadId).toBe("thread-native");
    expect(preservedBinding?.mcpServersFingerprint).toBe("mcp-v1");
  });

  it("preserves MCP-mismatched bindings when provider web-search support is unknown", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    await writeCodexAppServerBinding(sessionFile, {
      threadId: "thread-native",
      cwd: workspaceDir,
      model: "gpt-5.4-codex",
      modelProvider: "openai",
      dynamicToolsFingerprint: "[]",
      webSearchThreadConfigFingerprint: "web-search-v1",
      mcpServersFingerprint: "mcp-v1",
    });
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-fallback");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      mcpServersFingerprint: undefined,
      mcpServersFingerprintEvaluated: true,
      nativeProviderWebSearchSupport: "unknown",
      userMcpServersEnabled: false,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const preservedBinding = await readCodexAppServerBinding(sessionFile);
    expect(preservedBinding?.threadId).toBe("thread-native");
    expect(preservedBinding?.mcpServersFingerprint).toBe("mcp-v1");
  });

  it("starts a new thread without user MCP servers when runtime policy disables them", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const config = {
      mcp: {
        servers: {
          notes: {
            transport: "stdio",
            command: "node",
            args: ["/opt/notes-mcp/dist/index.js"],
          },
        },
      },
    } as unknown as EmbeddedRunAttemptParams["config"];
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-started");
      }
      if (method === "thread/resume") {
        return threadResumeResult("thread-existing");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, config),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    request.mockClear();

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, config),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
      nativeCodeModeEnabled: false,
      userMcpServersEnabled: false,
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const startParams = request.mock.calls[0]?.[1] as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    expect(startParams?.config?.mcp_servers).toBeUndefined();
  });

  it("starts a new thread when a user MCP Authorization bearer changes without storing the bearer", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    registerCodexTestSessionIdentity(sessionFile, "session-1", "agent:main:session-1");
    const workspaceDir = path.join(tempDir, "workspace");
    const url = await startPolicyHttpServer();
    const createConfig = (authorization: string) =>
      ({
        mcp: {
          servers: {
            ducktape: {
              transport: "streamable-http",
              url,
              headers: {
                Authorization: authorization,
                "x-tenant": "keep",
              },
            },
          },
        },
      }) as unknown as EmbeddedRunAttemptParams["config"];
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-with-current-bearer");
      }
      if (method === "thread/resume") {
        return threadResumeResult("thread-with-stale-bearer");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, createConfig("Bearer access-token-one")),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });
    const firstBinding = await readCodexAppServerBinding(sessionFile);
    expect(firstBinding?.userMcpServersFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(firstBinding?.userMcpServersFingerprint).not.toContain("access-token-one");

    request.mockClear();

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, createConfig("Bearer access-token-two")),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    const startParams = request.mock.calls[0]?.[1] as {
      config?: { mcp_servers?: Record<string, { http_headers?: Record<string, string> }> };
    };
    expect(startParams?.config?.mcp_servers?.ducktape?.http_headers?.Authorization).toBe(
      "Bearer access-token-two",
    );
    const secondBinding = await readCodexAppServerBinding(sessionFile);
    expect(secondBinding?.userMcpServersFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(secondBinding?.userMcpServersFingerprint).not.toContain("access-token-two");
    expect(secondBinding?.userMcpServersFingerprint).not.toBe(
      firstBinding?.userMcpServersFingerprint,
    );
  });

  it("omits MCP OAuth servers before policy discovery for a remote app-server", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    let mcpRequestCount = 0;
    const mcpServer = http.createServer((_request, response) => {
      mcpRequestCount += 1;
      response.writeHead(401).end();
    });
    await new Promise<void>((resolve) => {
      mcpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = mcpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback MCP server address");
    }
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-without-oauth-mcp");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    try {
      await startOrResumeThread({
        client: { request } as never,
        params: createParams(sessionFile, workspaceDir, {
          tools: { deny: ["ducktape__restricted"] },
          mcp: {
            servers: {
              ducktape: {
                transport: "streamable-http",
                url: `http://127.0.0.1:${address.port}/mcp`,
                auth: "oauth",
              },
            },
          },
        } as unknown as EmbeddedRunAttemptParams["config"]),
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: {
          ...createAppServerOptions(),
          connectionClass: "remote",
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        mcpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    const startParams = request.mock.calls[0]?.[1] as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    expect(startParams?.config?.mcp_servers).toBeUndefined();
    expect(mcpRequestCount).toBe(0);
  });

  it("resends user MCP config when resuming a thread with the matching fingerprint", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const serverPath = await writePolicyProbeServer(tempDir);
    const config = {
      mcp: {
        servers: {
          notes: {
            transport: "stdio",
            command: process.execPath,
            args: [serverPath],
          },
        },
      },
    } as unknown as EmbeddedRunAttemptParams["config"];
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "thread/start") {
        return threadStartResult("thread-with-user-mcp");
      }
      if (method === "thread/resume") {
        return threadResumeResult("thread-with-user-mcp");
      }
      throw new Error(`unexpected method: ${method}`);
    });

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, config),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    request.mockClear();

    await startOrResumeThread({
      client: { request } as never,
      params: createParams(sessionFile, workspaceDir, config),
      cwd: workspaceDir,
      dynamicTools: [],
      appServer: createAppServerOptions(),
    });

    const resumeCall = request.mock.calls.find(([method]) => method === "thread/resume");
    const resumeParams = resumeCall?.[1] as {
      config?: { mcp_servers?: Record<string, unknown> };
    };
    expect(resumeCall).toBeDefined();
    expect(resumeParams?.config?.mcp_servers).toMatchObject({
      notes: { command: process.execPath, args: [serverPath] },
    });
  });
});
