/** Transport-independent CLI node-host runtime shared by Gateway and app workers. */
import fs from "node:fs";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import type { OpenClawConfig } from "../config/config.js";
import { getRuntimeConfig } from "../config/config.js";
import type { SkillBinTrustEntry } from "../infra/exec-approvals.js";
import { resolveExecutableFromPathEnv } from "../infra/executable-path.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_DEVICE_APPS_COMMAND,
  NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS,
  NODE_EXEC_APPROVALS_COMMANDS,
  NODE_FS_LIST_DIR_COMMAND,
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_SYSTEM_RUN_COMMANDS,
  NODE_TERMINAL_UPLOAD_COMMAND,
} from "../infra/node-commands.js";
import type { NodeWorkerCapacitySnapshot } from "../infra/node-runner-inventory.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { ensureTerminalUploadCleanup } from "../infra/terminal-file-upload.js";
import { logDebug } from "../logger.js";
import type { ComputerUseCapabilityDescriptor } from "../plugins/computer-use-contract.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import type { OpenClawPluginNodeHostCommandContext } from "../plugins/types.node-host.js";
import { BoundedBuffer } from "../shared/bounded-buffer.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import type { NodeHostClient } from "./client.js";
import { handleInvoke, type NodeInvokeRequestPayload, type SkillBinsProvider } from "./invoke.js";
import { startNodeHostMcpManager, type NodeHostMcpManager } from "./mcp.js";
import { buildNodeEventParams } from "./node-event-params.js";
import { createNodeInvokeProgressWriter } from "./node-invoke-progress.js";
import { NodeWorkerBundleInstaller } from "./node-worker-bundle-installer.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";
import {
  ensureNodeHostPluginRegistry,
  isRegisteredNodeHostCommandDuplex,
  listRegisteredNodeHostCapsAndCommands,
  notifyRegisteredNodeHostCommandDisconnect,
  watchRegisteredNodeHostCommandAvailability,
} from "./plugin-node-host.js";
import { scanNodeHostedSkills } from "./skills.js";

const DEFAULT_NODE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

type NodeHostManifest = {
  caps: string[];
  commands: string[];
  computerUse?: ComputerUseCapabilityDescriptor;
  pathEnv: string;
};

export type NodeHostInventory = {
  skills: unknown[] | null;
  pluginTools: unknown[];
};

type PreparedNodeHostRuntime = {
  manifest: NodeHostManifest;
  workerHostingEnabled: boolean;
  initialInventory: NodeHostInventory;
  start(params: {
    client: NodeHostClient;
    onInventoryChanged?: (inventory: NodeHostInventory) => void;
    onManifestChanged?: (manifest: NodeHostManifest) => void;
    onRunnerCapacityChanged?: (capacity: NodeWorkerCapacitySnapshot) => void;
  }): ActiveNodeHostRuntime;
};

type ActiveNodeHostRuntime = {
  invoke(frame: NodeInvokeRequestPayload): Promise<void>;
  handleInput(invokeId: string, seq: number, payloadJSON: string): void;
  cancel(invokeId: string): void;
  cancelAll(): void;
  updateGatewayConnection(connection?: {
    url: string;
    tlsFingerprint?: string;
    cloudflareAccess?: CloudflareAccessCredentials;
  }): void;
  close(): Promise<void>;
};

type NodeInvokeInputTarget = {
  nextInputSeq: number;
  input?: (payloadJSON: string) => void;
  // Buffer spawn-window input so its sequence cannot wedge before PTY registration.
  pendingInput: BoundedBuffer<string>;
  inputFailed: boolean;
};

type ActiveNodeInvoke = {
  controller: AbortController;
  input?: NodeInvokeInputTarget;
};

const MAX_PENDING_INVOKE_INPUT_BYTES = 64 * 1024;

function dispatchNodeInvokeInput(
  target: NodeInvokeInputTarget | undefined,
  seq: number,
  payloadJSON: string,
): boolean {
  if (!target || target.inputFailed || seq < target.nextInputSeq) {
    return false;
  }
  if (seq > target.nextInputSeq) {
    logDebug(`node-host: input sequence gap: expected ${target.nextInputSeq}, received ${seq}`);
  }
  target.nextInputSeq = seq + 1;
  if (target.input) {
    target.input(payloadJSON);
    return true;
  }
  if (!target.pendingInput.push(payloadJSON)) {
    target.inputFailed = true;
    logDebug("node-host: aborted invoke after buffered input exceeded 64 KiB");
    return false;
  }
  return true;
}

function registerNodeInvokeInputHandler(
  target: NodeInvokeInputTarget,
  input: (payloadJSON: string) => void,
): void {
  if (target.inputFailed) {
    return;
  }
  target.input = input;
  for (const pending of target.pendingInput.drain()) {
    input(pending);
  }
}

function resolveExecutablePathFromEnv(bin: string, pathEnv: string): string | null {
  if (bin.includes("/") || bin.includes("\\")) {
    return null;
  }
  return resolveExecutableFromPathEnv(bin, pathEnv) ?? null;
}

function resolveExecutableTrustPathFromEnv(bin: string, pathEnv: string): string | null {
  const resolvedPath = resolveExecutablePathFromEnv(bin, pathEnv);
  if (!resolvedPath) {
    return null;
  }
  try {
    return fs.realpathSync(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function resolveSkillBinTrustEntries(bins: string[], pathEnv: string): SkillBinTrustEntry[] {
  const trustEntries: SkillBinTrustEntry[] = [];
  const seen = new Set<string>();
  for (const raw of bins) {
    const name = raw.trim();
    if (!name) {
      continue;
    }
    const resolvedPath = resolveExecutableTrustPathFromEnv(name, pathEnv);
    if (!resolvedPath) {
      continue;
    }
    const key = `${name}\u0000${resolvedPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    trustEntries.push({ name, resolvedPath });
  }
  return trustEntries.toSorted(
    (left, right) =>
      left.name.localeCompare(right.name) || left.resolvedPath.localeCompare(right.resolvedPath),
  );
}

class SkillBinsCache implements SkillBinsProvider {
  private bins: SkillBinTrustEntry[] = [];
  private lastRefresh = 0;
  private readonly ttlMs = 90_000;

  constructor(
    private readonly client: NodeHostClient,
    private readonly pathEnv: string,
  ) {}

  async current(force = false): Promise<SkillBinTrustEntry[]> {
    if (force || Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
    return this.bins;
  }

  private async refresh() {
    try {
      const res = await this.client.request<{ bins: Array<unknown> }>("skills.bins", {});
      const bins = Array.isArray(res?.bins) ? res.bins.map((bin) => String(bin)) : [];
      this.bins = resolveSkillBinTrustEntries(bins, this.pathEnv);
      this.lastRefresh = Date.now();
    } catch {
      if (!this.lastRefresh) {
        this.bins = [];
      }
    }
  }
}

function ensureNodePathEnv(): string {
  ensureOpenClawCliOnPath({ pathEnv: process.env.PATH ?? "" });
  const current = process.env.PATH ?? "";
  if (current.trim()) {
    return current;
  }
  process.env.PATH = DEFAULT_NODE_PATH;
  return DEFAULT_NODE_PATH;
}

function createInventory(
  skills: unknown[] | null,
  pluginTools: unknown[],
  mcpDescriptors: readonly unknown[] = [],
): NodeHostInventory {
  const sortedPluginTools = [...pluginTools, ...mcpDescriptors].toSorted((left, right) => {
    const a = left as { pluginId?: string; name?: string };
    const b = right as { pluginId?: string; name?: string };
    return (
      (a.pluginId ?? "").localeCompare(b.pluginId ?? "") ||
      (a.name ?? "").localeCompare(b.name ?? "")
    );
  });
  return { skills, pluginTools: sortedPluginTools };
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameManifest(left: NodeHostManifest, right: NodeHostManifest): boolean {
  return (
    left.pathEnv === right.pathEnv &&
    sameStringList(left.caps, right.caps) &&
    sameStringList(left.commands, right.commands) &&
    JSON.stringify(left.computerUse) === JSON.stringify(right.computerUse)
  );
}

export async function prepareNodeHostRuntime(params?: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  /** The embedded app worker never advertises native agent runs. */
  enableAgentRuns?: boolean;
  /** The embedded app worker never advertises full worker session hosting. */
  enableWorkerRuns?: boolean;
  /** Process-scoped worker hosting for environment-managed disposable nodes. */
  forceWorkerRuns?: boolean;
  /** Embedded workers may still host long-lived plugin commands over the app-owned socket. */
  enableDuplexPluginCommands?: boolean;
  installedAppsSharingEnabled?: boolean;
  platform?: NodeJS.Platform;
}): Promise<PreparedNodeHostRuntime> {
  void ensureTerminalUploadCleanup();
  const config = params?.config ?? getRuntimeConfig();
  const env = params?.env ?? process.env;
  await ensureNodeHostPluginRegistry({ config, env });
  const pathEnv = ensureNodePathEnv();
  env.PATH = pathEnv;
  const duplexEnabled =
    params?.enableAgentRuns === true || params?.enableDuplexPluginCommands === true;
  const platform = params?.platform ?? process.platform;
  const installedAppsSharingEnabled =
    platform === "darwin" && params?.installedAppsSharingEnabled === true;
  const desktopStreamingEnabled =
    (platform === "darwin" || platform === "linux" || platform === "win32") &&
    config.desktop?.host?.enabled === true;
  const availabilityContext = { config, env };
  const resolvePluginNodeHost = () =>
    listRegisteredNodeHostCapsAndCommands(availabilityContext, {
      includeDuplex: duplexEnabled,
    });
  const pluginNodeHost = resolvePluginNodeHost();
  // Opt-in and binary resolution are node-local enforcement points. A Gateway
  // cannot advertise or enable this command on the host's behalf.
  const claudePath =
    params?.enableAgentRuns === true && config.nodeHost?.agentRuns?.claude?.enabled === true
      ? resolveExecutableTrustPathFromEnv("claude", pathEnv)
      : null;
  const workerRunsEnabled =
    params?.enableWorkerRuns === true &&
    (params.forceWorkerRuns === true || config.nodeHost?.workerRuns?.enabled === true);
  const skills = config.nodeHost?.skills?.enabled === false ? null : scanNodeHostedSkills();
  const buildManifest = (pluginManifest: typeof pluginNodeHost): NodeHostManifest => ({
    caps: [
      ...new Set([
        "system",
        "mcp",
        ...(installedAppsSharingEnabled ? ["device"] : []),
        ...pluginManifest.caps,
      ]),
    ].toSorted(),
    commands: [
      ...new Set([
        ...NODE_SYSTEM_RUN_COMMANDS,
        ...NODE_EXEC_APPROVALS_COMMANDS,
        NODE_FS_LIST_DIR_COMMAND,
        NODE_TERMINAL_UPLOAD_COMMAND,
        NODE_MCP_TOOLS_CALL_COMMAND,
        ...(desktopStreamingEnabled ? [NODE_DESKTOP_STREAM_COMMAND] : []),
        ...(installedAppsSharingEnabled ? [NODE_DEVICE_APPS_COMMAND] : []),
        ...(claudePath ? [NODE_AGENT_CLI_CLAUDE_RUN_COMMAND] : []),
        ...pluginManifest.commands,
      ]),
    ].toSorted(),
    ...(pluginManifest.computerUse ? { computerUse: pluginManifest.computerUse } : {}),
    pathEnv,
  });
  const manifest = buildManifest(pluginNodeHost);
  const initialInventory = createInventory(skills, pluginNodeHost.nodePluginTools);

  return {
    manifest,
    workerHostingEnabled: workerRunsEnabled,
    initialInventory,
    start({ client, onInventoryChanged, onManifestChanged, onRunnerCapacityChanged }) {
      const mcpAbort = new AbortController();
      const workerWorkspace = workerRunsEnabled
        ? new NodeWorkerWorkspaceRuntime({ env })
        : undefined;
      const workerBundleInstaller = workerRunsEnabled
        ? new NodeWorkerBundleInstaller({ env })
        : undefined;
      const workerSupervisor = workerRunsEnabled
        ? createNodeWorkerSupervisor({
            env,
            onCapacityChanged: onRunnerCapacityChanged,
            workspace: workerWorkspace,
          })
        : undefined;
      if (workerSupervisor) {
        void workerSupervisor.initialize().catch((error: unknown) => {
          logDebug(`node-host: worker capacity reconciliation failed: ${String(error)}`);
        });
      }
      const skillBins = new SkillBinsCache(client, pathEnv);
      const activeInvokes = new Map<string, ActiveNodeInvoke>();
      let pluginDisconnectCleanup: Promise<void> = Promise.resolve();
      const pluginCommandContext: OpenClawPluginNodeHostCommandContext = {
        sendNodeEvent: async (event, payload) =>
          await client.request("node.event", buildNodeEventParams(event, payload)),
      };
      let currentPluginNodeHost = pluginNodeHost;
      let currentManifest = manifest;
      let gatewayConnection:
        | {
            url: string;
            tlsFingerprint?: string;
            cloudflareAccess?: CloudflareAccessCredentials;
          }
        | undefined;
      let manager: NodeHostMcpManager | undefined;
      let closing = false;
      let closePromise: Promise<void> | undefined;
      const publishInventory = () =>
        onInventoryChanged?.(
          createInventory(skills, currentPluginNodeHost.nodePluginTools, manager?.descriptors),
        );
      const startup = startNodeHostMcpManager(config.nodeHost?.mcp?.servers, {
        signal: mcpAbort.signal,
        onDescriptorsChanged: () => {
          if (!closing && manager) {
            publishInventory();
          }
        },
      }).then((resolved) => {
        manager = resolved;
        if (!closing) {
          publishInventory();
        }
        return resolved;
      });
      const refreshAvailability = () => {
        const nextPluginNodeHost = resolvePluginNodeHost();
        const nextManifest = buildManifest(nextPluginNodeHost);
        currentPluginNodeHost = nextPluginNodeHost;
        if (!sameManifest(currentManifest, nextManifest)) {
          currentManifest = nextManifest;
          onManifestChanged?.(nextManifest);
        }
        publishInventory();
      };
      const stopAvailabilityWatch = onManifestChanged
        ? watchRegisteredNodeHostCommandAvailability(availabilityContext, refreshAvailability)
        : () => {};
      // The watcher cannot replay a socket change between preparation and
      // registration. Resolve once after attachment to close that race.
      if (onManifestChanged) {
        refreshAvailability();
      }
      return {
        async invoke(frame) {
          await pluginDisconnectCleanup;
          const duplexCommand = duplexEnabled && isRegisteredNodeHostCommandDuplex(frame.command);
          const progressEnabled = duplexCommand || frame.command === NODE_DESKTOP_STREAM_COMMAND;
          const controller = new AbortController();
          // Every command must remain cancellable after dispatch; only duplex
          // commands own ordered input and its pre-spawn buffer.
          const input: NodeInvokeInputTarget | undefined = duplexCommand
            ? {
                nextInputSeq: 0,
                pendingInput: new BoundedBuffer<string>(
                  MAX_PENDING_INVOKE_INPUT_BYTES,
                  {
                    mode: "fail-closed",
                    onOverflow: () =>
                      controller.abort(
                        new Error("terminal input exceeded the 64 KiB pre-spawn buffer"),
                      ),
                  },
                  (payload) => Buffer.byteLength(payload, "utf8"),
                ),
                inputFailed: false,
              }
            : undefined;
          const active: ActiveNodeInvoke = { controller, ...(input ? { input } : {}) };
          // Redelivered IDs must not orphan the original command's process or
          // let its cleanup unregister the replacement invocation.
          activeInvokes.get(frame.id)?.controller.abort();
          activeInvokes.set(frame.id, active);
          const progress = progressEnabled
            ? createNodeInvokeProgressWriter({
                client,
                frame,
                idleTimeoutMs: NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS,
                onError: () => controller.abort(),
              })
            : undefined;
          if (duplexCommand) {
            progress?.startHeartbeats();
          }
          const pluginCommandIo: OpenClawPluginNodeHostCommandIo | undefined =
            input && progress
              ? {
                  signal: controller.signal,
                  emitChunk: async (chunk) => await progress.write(chunk),
                  onInput: (callback) => {
                    if (activeInvokes.get(frame.id) === active) {
                      registerNodeInvokeInputHandler(input, callback);
                    }
                  },
                }
              : undefined;
          try {
            await handleInvoke(frame, client, skillBins, manager, {
              ...(claudePath ? { claudePath } : {}),
              signal: controller.signal,
              ...(pluginCommandIo ? { pluginCommandIo } : {}),
              ...(gatewayConnection?.url ? { gatewayUrl: gatewayConnection.url } : {}),
              ...(gatewayConnection?.tlsFingerprint
                ? { gatewayTlsFingerprint: gatewayConnection.tlsFingerprint }
                : {}),
              ...(gatewayConnection?.cloudflareAccess
                ? { gatewayCloudflareAccess: gatewayConnection.cloudflareAccess }
                : {}),
              ...(config.desktop?.host ? { desktopHostConfig: config.desktop.host } : {}),
              ...(progress ? { emitProgress: (text) => progress.write(text) } : {}),
              installedAppsSharingEnabled,
              installedAppsPlatform: platform,
              pluginCommandContext,
              ...(workerBundleInstaller ? { workerBundleInstaller } : {}),
              ...(workerSupervisor ? { workerSupervisor } : {}),
              ...(workerWorkspace ? { workerWorkspace } : {}),
            });
          } finally {
            progress?.stop();
            await progress?.flush();
            if (activeInvokes.get(frame.id) === active) {
              activeInvokes.delete(frame.id);
            }
          }
        },
        handleInput(invokeId, seq, payloadJSON) {
          const input = activeInvokes.get(invokeId)?.input;
          if (!dispatchNodeInvokeInput(input, seq, payloadJSON)) {
            logDebug(`node-host: dropped inactive or duplicate input for invoke ${invokeId}`);
          }
        },
        cancel(invokeId) {
          activeInvokes.get(invokeId)?.controller.abort();
        },
        cancelAll() {
          for (const active of activeInvokes.values()) {
            active.controller.abort();
          }
          activeInvokes.clear();
          pluginDisconnectCleanup = pluginDisconnectCleanup
            .then(async () => await notifyRegisteredNodeHostCommandDisconnect())
            .catch((error: unknown) => {
              logDebug(`node-host: plugin disconnect cleanup failed: ${String(error)}`);
            });
        },
        updateGatewayConnection(connection) {
          gatewayConnection = connection;
        },
        close() {
          if (closePromise) {
            return closePromise;
          }
          closing = true;
          this.cancelAll();
          const preludeErrors: unknown[] = [];
          try {
            stopAvailabilityWatch();
          } catch (error) {
            preludeErrors.push(error);
          }
          // Startup observes this signal before either independent owner is joined.
          mcpAbort.abort();
          const disconnectClose = pluginDisconnectCleanup;
          const supervisorClose = Promise.resolve().then(() => workerSupervisor?.close());
          const mcpClose = startup.then((resolved) => resolved.close());
          closePromise = Promise.allSettled([disconnectClose, supervisorClose, mcpClose]).then(
            (results) => {
              const errors = [
                ...preludeErrors,
                ...results.flatMap((result) =>
                  result.status === "rejected" ? [result.reason] : [],
                ),
              ];
              if (errors.length === 1) {
                throw errors[0];
              }
              if (errors.length > 1) {
                throw new AggregateError(errors, "node-host runtime close failed");
              }
            },
          );
          return closePromise;
        },
      };
    },
  };
}
