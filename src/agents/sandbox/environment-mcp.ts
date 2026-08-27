import crypto from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { SessionToolOverrides } from "../../config/sessions/types.js";
import { extractMcpServerMap, type BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
import { materializeBundleMcpToolsForRun } from "../agent-bundle-mcp-materialize.js";
import { createSessionMcpRuntime } from "../agent-bundle-mcp-runtime.js";
import type { BundleMcpToolRuntime } from "../agent-bundle-mcp-types.js";
import { OpenClawStdioClientTransport } from "../mcp-stdio-transport.js";
import { resolveMcpTransportConfig } from "../mcp-transport-config.js";
import type { ResolvedMcpTransport } from "../mcp-transport.js";
import type {
  SandboxBackendHandle,
  SandboxCapabilityRootDiscovery,
} from "./backend-handle.types.js";
import { shellEscape } from "./ssh.js";

class SandboxStdioMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private inner?: OpenClawStdioClientTransport;
  private finalizeToken?: unknown;
  private finalizePromise?: Promise<void>;
  private failed = false;

  constructor(
    private readonly backend: SandboxBackendHandle,
    private readonly server: {
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
    },
  ) {}

  async start(): Promise<void> {
    const command = [this.server.command, ...this.server.args].map(shellEscape).join(" ");
    const prepared = await this.backend.buildExecSpec({
      command,
      workdir: this.server.cwd ?? this.backend.workdir,
      env: this.server.env ?? {},
      usePty: false,
    });
    if (prepared.stdinMode !== "pipe-open" || prepared.argv.length === 0) {
      throw new Error(`Sandbox backend "${this.backend.id}" cannot host stdio MCP`);
    }
    this.finalizeToken = prepared.finalizeToken;
    const spawnCommand = prepared.argv[0];
    if (!spawnCommand) {
      throw new Error(`Sandbox backend "${this.backend.id}" returned an empty MCP command`);
    }
    const spawnArgs = prepared.argv.slice(1);
    const spawnEnv = Object.fromEntries(
      Object.entries(prepared.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    const inner = new OpenClawStdioClientTransport({
      command: spawnCommand,
      args: spawnArgs,
      env: spawnEnv,
      stderr: "pipe",
    });
    inner.onmessage = (message) => this.onmessage?.(message);
    inner.onerror = (error) => {
      this.failed = true;
      this.onerror?.(error);
    };
    inner.onclose = () => {
      void this.finalize().then(
        () => this.onclose?.(),
        (error: unknown) => {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          this.onclose?.();
        },
      );
    };
    this.inner = inner;
    try {
      await inner.start();
    } catch (error) {
      this.failed = true;
      await this.finalize();
      throw error;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.inner) {
      throw new Error("Sandbox stdio MCP transport is not started");
    }
    await this.inner.send(message);
  }

  async close(): Promise<void> {
    try {
      await this.inner?.close();
    } finally {
      await this.finalize();
    }
  }

  private async finalize(): Promise<void> {
    if (!this.finalizePromise) {
      this.finalizePromise =
        this.backend.finalizeExec?.({
          status: this.failed ? "failed" : "completed",
          exitCode: null,
          timedOut: false,
          token: this.finalizeToken,
        }) ?? Promise.resolve();
    }
    await this.finalizePromise;
  }
}

function collectDiscoveredStdioServers(
  discoveries: readonly SandboxCapabilityRootDiscovery[],
): Record<string, BundleMcpServerConfig> {
  const servers: Record<string, BundleMcpServerConfig> = {};
  for (const discovery of discoveries) {
    if (!discovery.mcpConfig || discovery.error) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(discovery.mcpConfig.contents);
    } catch {
      continue;
    }
    for (const [name, server] of Object.entries(extractMcpServerMap(parsed))) {
      const resolved = resolveMcpTransportConfig(name, server);
      if (resolved?.kind !== "stdio" || Object.hasOwn(servers, name)) {
        continue;
      }
      servers[name] = server;
    }
  }
  return servers;
}

export async function createSandboxEnvironmentMcpToolRuntime(params: {
  backend: SandboxBackendHandle;
  discoveries: readonly SandboxCapabilityRootDiscovery[];
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  reservedToolNames?: Iterable<string>;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
}): Promise<BundleMcpToolRuntime | undefined> {
  const discoveredServers = collectDiscoveredStdioServers(params.discoveries);
  const mcpServers = Object.fromEntries(
    Object.entries(discoveredServers).filter(
      ([name]) => params.toolOverrides?.mcpServers?.[name] !== false,
    ),
  );
  if (Object.keys(mcpServers).length === 0) {
    return undefined;
  }
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify([params.backend.id, params.backend.runtimeId, mcpServers]))
    .digest("hex");
  const runtime = createSessionMcpRuntime({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    configFingerprint: fingerprint,
    mcpServersOverride: mcpServers,
    toolOverrides: params.toolOverrides,
    resolveTransport: async (serverName, rawServer): Promise<ResolvedMcpTransport | null> => {
      const resolved = resolveMcpTransportConfig(serverName, rawServer);
      if (resolved?.kind !== "stdio") {
        return null;
      }
      return {
        transport: new SandboxStdioMcpTransport(params.backend, {
          ...resolved,
          args: resolved.args ?? [],
        }),
        description: `${serverName}: sandbox environment stdio`,
        transportType: "stdio",
        connectionTimeoutMs: resolved.connectionTimeoutMs,
        requestTimeoutMs: resolved.requestTimeoutMs,
        supportsParallelToolCalls: resolved.supportsParallelToolCalls,
      };
    },
  });
  try {
    return await materializeBundleMcpToolsForRun({
      runtime,
      reservedToolNames: params.reservedToolNames,
      disposeRuntime: async () => await runtime.dispose(),
    });
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
