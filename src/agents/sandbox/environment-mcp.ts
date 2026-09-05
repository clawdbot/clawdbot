import crypto from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { SessionToolOverrides } from "../../config/sessions/types.js";
import type { SandboxEnvironmentCapabilityRootConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { logWarn } from "../../logger.js";
import { extractMcpServerMap, type BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
import { materializeBundleMcpToolsForRun } from "../agent-bundle-mcp-materialize.js";
import { createSessionMcpRuntime } from "../agent-bundle-mcp-runtime.js";
import type { BundleMcpToolRuntime } from "../agent-bundle-mcp-types.js";
import { OpenClawStdioClientTransport } from "../mcp-stdio-transport.js";
import { resolveMcpTransportConfig } from "../mcp-transport-config.js";
import { attachMcpStderrLogging, type ResolvedMcpTransport } from "../mcp-transport.js";
import type { SandboxBackendExecSpec, SandboxBackendHandle } from "./backend-handle.types.js";
import type {
  SandboxEnvironmentCapabilityDiscovery,
  SandboxEnvironmentMcpAuthorization,
} from "./environment-capabilities.js";
import { isPathInsideContainerRoot } from "./path-utils.js";
import { prepareSandboxRemoteProcess } from "./remote-process.js";
import { shellEscape } from "./ssh.js";

class SandboxStdioMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private inner?: OpenClawStdioClientTransport;
  private prepared?: SandboxBackendExecSpec;
  private finalizePromise?: Promise<void>;
  private detachStderr?: () => void;
  private remoteProcess?: ReturnType<typeof prepareSandboxRemoteProcess>;
  private closed = false;
  private started = false;
  private launched = false;
  private failed = false;

  constructor(
    private readonly backend: SandboxBackendHandle,
    private readonly root: string,
    private readonly serverName: string,
    private readonly server: {
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
    },
    private readonly isAuthorized: () => boolean,
  ) {}

  async start(): Promise<void> {
    if (this.closed || this.started) {
      throw new Error("Sandbox MCP transport is closed or already started");
    }
    this.started = true;
    let validated: string | null | undefined;
    try {
      if (!this.isAuthorized()) {
        throw new Error("Sandbox MCP startup authorization was revoked");
      }
      const workdir = path.posix.resolve(this.root, this.server.cwd ?? ".");
      if (!isPathInsideContainerRoot(this.root, workdir) || !this.backend.validateWorkdir) {
        throw new Error(
          "Sandbox MCP cwd must remain inside its discovery root and support backend validation",
        );
      }
      validated = await this.backend.validateWorkdir(workdir);
      if (this.closed) {
        throw new Error("Sandbox MCP startup was cancelled");
      }
      if (!this.isAuthorized()) {
        throw new Error("Sandbox MCP startup authorization was revoked");
      }
      if (
        !validated ||
        !path.posix.isAbsolute(validated) ||
        !isPathInsideContainerRoot(this.root, validated)
      ) {
        throw new Error("Sandbox MCP cwd validation failed or startup was cancelled");
      }
      this.remoteProcess = prepareSandboxRemoteProcess(this.backend, {
        ...this.backend.env,
        ...this.server.env,
      });
      this.prepared = await this.backend.buildExecSpec({
        command: [this.server.command, ...this.server.args].map(shellEscape).join(" "),
        workdir: validated,
        env: this.remoteProcess.env,
        usePty: false,
      });
      // Preparation can finish after disposal or config reload. Retain its lease for cleanup,
      // then revalidate synchronously before the process boundary so neither closure nor grant
      // revocation can launch a stale transport.
      if (this.closed || this.prepared.stdinMode !== "pipe-open" || !this.prepared.argv[0]) {
        throw new Error("Sandbox MCP startup was cancelled or the backend cannot host stdio MCP");
      }
      if (!this.isAuthorized()) {
        throw new Error("Sandbox MCP startup authorization was revoked");
      }
      const inner = new OpenClawStdioClientTransport({
        command: this.prepared.argv[0],
        args: this.prepared.argv.slice(1),
        env: Object.fromEntries(
          Object.entries(this.prepared.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        stderr: "pipe",
      });
      this.detachStderr = attachMcpStderrLogging(this.serverName, inner);
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses SDK callback properties, not EventTarget.
      inner.onmessage = (message) => this.onmessage?.(message);
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses SDK callback properties, not EventTarget.
      inner.onerror = (error) => {
        this.failed = true;
        this.onerror?.(error);
      };
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Transport uses SDK callback properties, not EventTarget.
      inner.onclose = () => {
        this.closed = true;
        void this.finalize().then(
          () => this.onclose?.(),
          (error: unknown) => {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)));
            this.onclose?.();
          },
        );
      };
      this.inner = inner;
      this.launched = true;
      await inner.start();
    } catch (error) {
      this.failed = true;
      this.closed = true;
      if (!this.prepared && validated) {
        this.backend.discardPreparedWorkdir?.(validated);
      }
      try {
        await this.inner?.forceClose();
      } finally {
        await this.finalize();
      }
      throw error;
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.inner) {
      throw new Error("Sandbox MCP transport is not connected");
    }
    await this.inner.send(message);
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.inner?.close();
    } finally {
      await this.finalize();
    }
  }

  async forceClose(): Promise<void> {
    this.closed = true;
    try {
      await this.inner?.forceClose();
    } finally {
      await this.finalize();
    }
  }

  private async finalize(): Promise<void> {
    // An early close owns no lease yet. Do not cache cleanup of an undefined
    // token: late preparation must still finalize its actual resource once.
    const prepared = this.prepared;
    if (!prepared) {
      return;
    }
    this.finalizePromise ??= (async () => {
      try {
        if (this.launched) {
          await this.remoteProcess?.terminate();
        }
      } catch (error) {
        this.failed = true;
        throw error;
      } finally {
        try {
          await this.backend.finalizeExec?.({
            status: this.failed ? "failed" : "completed",
            exitCode: null,
            timedOut: false,
            token: prepared.finalizeToken,
          });
        } finally {
          this.detachStderr?.();
        }
      }
    })().catch((error: unknown) => {
      logWarn(
        "Sandbox MCP finalization failed; recreate the sandbox and inspect remaining processes.",
      );
      throw error;
    });
    await this.finalizePromise;
  }
}

type AuthorizedSandboxMcpServer = {
  root: string;
  config: BundleMcpServerConfig;
  authorization: SandboxEnvironmentMcpAuthorization;
};

function resolveSandboxMcpLaunchIdentity(
  serverName: string,
  root: string,
  config: BundleMcpServerConfig,
) {
  const resolved = resolveMcpTransportConfig(serverName, config, { logWarnings: false });
  if (resolved?.kind !== "stdio") {
    return undefined;
  }
  return {
    command: resolved.command,
    args: resolved.args ?? [],
    cwd: path.posix.resolve(root, resolved.cwd ?? "."),
    env: resolved.env ?? {},
  };
}

function isAuthorizedSandboxMcpServer(params: {
  backend: SandboxBackendHandle;
  root: string;
  serverName: string;
  config: BundleMcpServerConfig;
  authorization: SandboxEnvironmentMcpAuthorization;
}): boolean {
  const requirement = params.authorization.mcpServers[params.serverName];
  return (
    requirement !== undefined &&
    params.authorization.backendId === params.backend.id &&
    params.authorization.runtimeId === params.backend.runtimeId &&
    params.authorization.rootPath === params.root &&
    isDeepStrictEqual(
      resolveSandboxMcpLaunchIdentity(params.serverName, params.root, params.config),
      resolveSandboxMcpLaunchIdentity(params.serverName, params.root, requirement),
    )
  );
}

function isCurrentSandboxMcpAuthorization(params: {
  backend: SandboxBackendHandle;
  root: string;
  serverName: string;
  config: BundleMcpServerConfig;
  authorization: SandboxEnvironmentMcpAuthorization;
  capabilityRoots: readonly SandboxEnvironmentCapabilityRootConfig[];
}): boolean {
  if (
    params.authorization.backendId !== params.backend.id ||
    params.authorization.runtimeId !== params.backend.runtimeId ||
    params.authorization.rootPath !== params.root
  ) {
    return false;
  }
  return params.capabilityRoots.some((root) => {
    const requirement = root.mcpServers[params.serverName];
    return (
      root.id === params.authorization.selectionId &&
      requirement !== undefined &&
      isDeepStrictEqual(
        resolveSandboxMcpLaunchIdentity(params.serverName, params.root, params.config),
        resolveSandboxMcpLaunchIdentity(params.serverName, params.root, requirement),
      )
    );
  });
}

export function collectDiscoveredSandboxMcpServers(
  discoveries: readonly SandboxEnvironmentCapabilityDiscovery[],
  backend: SandboxBackendHandle,
) {
  const servers = new Map<string, AuthorizedSandboxMcpServer>();
  let authorizationMismatch = false;
  for (const discovery of discoveries) {
    if (!discovery.mcpConfig || discovery.error) {
      continue;
    }
    if (
      discovery.path !== backend.workdir ||
      Buffer.byteLength(discovery.mcpConfig.contents) > 256 * 1024
    ) {
      logWarn("Sandbox MCP configuration skipped: invalid discovery root or file size limit.");
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(discovery.mcpConfig.contents);
    } catch {
      logWarn("Sandbox MCP configuration skipped: invalid JSON; repair the workspace .mcp.json.");
      continue;
    }
    const declarations = Object.entries(extractMcpServerMap(parsed));
    if (declarations.length > 64) {
      logWarn("Sandbox MCP discovery reached the 64-server limit.");
    }
    for (const [name, config] of declarations.slice(0, 64)) {
      if (config.enabled === false) {
        continue;
      }
      const resolved = resolveMcpTransportConfig(name, config);
      if (resolved?.kind !== "stdio") {
        logWarn(
          "Sandbox MCP declaration skipped: only stdio servers are supported in environment discovery.",
        );
        continue;
      }
      let matched = false;
      for (const authorization of discovery.mcpAuthorizations ?? []) {
        if (
          servers.has(name) ||
          !isAuthorizedSandboxMcpServer({
            backend,
            root: discovery.path,
            serverName: name,
            config,
            authorization,
          })
        ) {
          continue;
        }
        if (servers.size === 64) {
          logWarn("Sandbox MCP discovery reached the 64-server limit.");
          return servers;
        }
        servers.set(name, { root: discovery.path, config, authorization });
        matched = true;
      }
      authorizationMismatch ||= !matched;
    }
  }
  if (authorizationMismatch) {
    logWarn(
      "Sandbox MCP declaration skipped: no exact operator capability-root authorization matched.",
    );
  }
  return servers;
}

export async function createSandboxEnvironmentMcpToolRuntime(params: {
  backend: SandboxBackendHandle;
  servers: ReturnType<typeof collectDiscoveredSandboxMcpServers>;
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  signal?: AbortSignal;
  cfg?: OpenClawConfig;
  agentId?: string;
  reservedToolNames?: Iterable<string>;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
  readCurrentCapabilityRoots: () => readonly SandboxEnvironmentCapabilityRootConfig[];
}): Promise<BundleMcpToolRuntime | undefined> {
  params.signal?.throwIfAborted();
  const discovered = params.servers;
  const mcpServers = Object.fromEntries(
    [...discovered]
      .filter(([name]) => params.toolOverrides?.mcpServers?.[name] !== false)
      .map(([name, entry]) => [name, entry.config]),
  );
  if (Object.keys(mcpServers).length === 0) {
    return undefined;
  }
  const fingerprintEntries = [...discovered]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => [
      name,
      entry.authorization.selectionId,
      entry.authorization.backendId,
      entry.authorization.runtimeId,
      entry.authorization.rootPath,
      entry.config,
    ]);
  const fingerprint = crypto
    .createHash("sha256")
    .update(JSON.stringify(fingerprintEntries))
    .digest("hex");
  const runtime = createSessionMcpRuntime({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    toolOverrides: params.toolOverrides,
    executorOwned: {
      mcpServers,
      fingerprint,
      resolveTransport: async (serverName, rawServer): Promise<ResolvedMcpTransport | null> => {
        const resolved = resolveMcpTransportConfig(serverName, rawServer);
        const entry = discovered.get(serverName);
        const isLaunchAuthorized = () =>
          params.signal?.aborted !== true &&
          entry !== undefined &&
          isCurrentSandboxMcpAuthorization({
            backend: params.backend,
            root: entry.root,
            serverName,
            config: rawServer,
            authorization: entry.authorization,
            capabilityRoots: params.readCurrentCapabilityRoots(),
          });
        if (
          resolved?.kind !== "stdio" ||
          !entry ||
          !isAuthorizedSandboxMcpServer({
            backend: params.backend,
            root: entry.root,
            serverName,
            config: rawServer,
            authorization: entry.authorization,
          }) ||
          !isLaunchAuthorized()
        ) {
          return null;
        }
        return {
          transport: new SandboxStdioMcpTransport(
            params.backend,
            entry.root,
            serverName,
            { ...resolved, args: resolved.args ?? [] },
            isLaunchAuthorized,
          ),
          description: serverName + ": sandbox environment stdio",
          transportType: "stdio",
          connectionTimeoutMs: resolved.connectionTimeoutMs,
          requestTimeoutMs: resolved.requestTimeoutMs,
          supportsParallelToolCalls: resolved.supportsParallelToolCalls,
        };
      },
    },
  });
  try {
    return await racePromiseWithAbortSignal(
      materializeBundleMcpToolsForRun({
        runtime,
        agentId: params.agentId,
        reservedToolNames: params.reservedToolNames,
        disposeRuntime: async () => await runtime.dispose(),
      }),
      params.signal,
    );
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
