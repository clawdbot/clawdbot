import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { WORKER_BUNDLE_PREWARM_VERSION } from "../../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { DeviceIdentity } from "../../../../src/infra/device-identity.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import {
  NODE_WORKER_BUNDLE_INSTALL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
} from "../../../../src/infra/node-commands.js";
import {
  NODE_RUNNER_INVENTORY_UPDATE_METHOD,
  NODE_WORKER_BUNDLE_RETENTION_VERSION,
  NODE_WORKER_BUNDLE_STATUS_VERSION,
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../../../src/infra/node-runner-inventory.js";
import { handleInvoke, type NodeInvokeRequestPayload } from "../../../../src/node-host/invoke.js";
import { NodeWorkerBundleInstaller } from "../../../../src/node-host/node-worker-bundle-installer.js";
import type { NodeWorkerContainerEngine } from "../../../../src/node-host/node-worker-container-engine.js";
import { parseNodeWorkerLaunchInput } from "../../../../src/node-host/node-worker-supervisor-contract.js";
import { createNodeWorkerSupervisor } from "../../../../src/node-host/node-worker-supervisor.js";
import { NodeWorkerWorkspaceRuntime } from "../../../../src/node-host/node-worker-workspace.js";
import { VERSION } from "../../../../src/version.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";

const execFileAsync = promisify(execFile);
const NODE_DISPLAY_NAME = "QA Gateway-bundle worker node";

async function waitUntil<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error("timed out waiting for paired worker node state");
}

export type WireGateway = Awaited<ReturnType<typeof startQaGatewayChild>>;
type WireGatewayEvent = { event: string; payload?: unknown };
export type WireNodeRead = {
  nodeId: string;
  approvalState?: string;
  connected?: boolean;
  paired?: boolean;
  sessionHost?: boolean;
  workerBundle?: { status: "installed"; version: string } | { status: "missing" };
};
export type PublishedWireWorkspace = {
  commit: string;
  source: string;
  server: Server;
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return stdout.trim();
}

export async function closeWireServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function createPublishedWireWorkspace(root: string): Promise<PublishedWireWorkspace> {
  const source = path.join(root, "source");
  const bare = path.join(root, "repo.git");
  await fs.mkdir(source, { recursive: true });
  await execFileAsync("git", ["init", "--bare", bare]);
  await git(source, "init", "-b", "main");
  await git(source, "config", "user.name", "OpenClaw QA");
  await git(source, "config", "user.email", "openclaw-qa@example.invalid");
  await fs.mkdir(path.join(source, "nested"));
  await fs.writeFile(path.join(source, "launch-wire.txt"), "local-install launch wire\n");
  await fs.writeFile(path.join(source, "nested", "tracked.txt"), "nested tracked input\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "initialize node worker launch wire workspace");
  await git(source, "remote", "add", "publish", bare);
  await git(source, "push", "publish", "main");
  await git(source, "remote", "remove", "publish");
  await git(bare, "update-server-info");

  const server = createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      if (!pathname.startsWith("/repo.git/")) {
        response.writeHead(404).end();
        return;
      }
      const candidate = path.resolve(bare, pathname.slice("/repo.git/".length));
      if (candidate !== bare && !candidate.startsWith(`${bare}${path.sep}`)) {
        response.writeHead(404).end();
        return;
      }
      try {
        const contents = await fs.readFile(candidate);
        response.writeHead(200, {
          "content-type": pathname.endsWith("/info/refs")
            ? "text/plain; charset=utf-8"
            : "application/octet-stream",
          "content-length": String(contents.byteLength),
        });
        response.end(request.method === "HEAD" ? undefined : contents);
      } catch {
        response.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("published workspace server did not bind");
  }
  const origin = `http://127.0.0.1:${address.port}/repo.git`;
  await git(source, "remote", "add", "origin", origin);
  const commit = await git(source, "rev-parse", "HEAD");
  await git(source, "ls-remote", "--exit-code", origin, "refs/heads/main");
  return { commit, source: await fs.realpath(source), server };
}

export async function connectWireClient(params: {
  gateway: WireGateway;
  role: "operator" | "node";
  identity: DeviceIdentity | null;
  includeApprovals?: boolean;
  onEvent?: (event: WireGatewayEvent) => void;
  timeoutMs?: number;
}): Promise<GatewayClient> {
  return await new Promise<GatewayClient>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        client.stop();
        reject(error);
      } else {
        resolve(client);
      }
    };
    const timeout = setTimeout(
      () => finish(new Error("Gateway client connection timed out")),
      params.timeoutMs ?? 30_000,
    );
    timeout.unref();
    const node = params.role === "node";
    const client = new GatewayClient({
      url: params.gateway.wsUrl,
      token: params.gateway.token,
      env: params.gateway.runtimeEnv,
      role: params.role,
      clientName: node ? GATEWAY_CLIENT_NAMES.NODE_HOST : GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: node ? NODE_DISPLAY_NAME : "Paired node worker wire operator",
      clientVersion: VERSION,
      platform: node ? "macos" : process.platform,
      deviceFamily: node ? "Mac" : undefined,
      mode: node ? GATEWAY_CLIENT_MODES.NODE : GATEWAY_CLIENT_MODES.BACKEND,
      scopes: node
        ? []
        : [
            "operator.admin",
            "operator.pairing",
            "operator.read",
            "operator.write",
            ...(params.includeApprovals ? ["operator.approvals"] : []),
          ],
      caps: node
        ? ["system"]
        : params.includeApprovals
          ? [GATEWAY_CLIENT_CAPS.APPROVALS, GATEWAY_CLIENT_CAPS.EXEC_APPROVALS]
          : undefined,
      commands: node ? [] : undefined,
      deviceIdentity: params.identity,
      requestTimeoutMs: PROOF_TIMEOUT_MS,
      onEvent: params.onEvent,
      onHelloOk: () => finish(),
      onConnectError: (error) => finish(error),
      onClose: (code, reason) => finish(new Error(`Gateway closed (${code}): ${reason}`)),
    });
    client.start();
  });
}

function isPairingRequired(error: unknown): boolean {
  const details =
    error && typeof error === "object"
      ? (error as { details?: { code?: unknown } }).details
      : undefined;
  return details?.code === "PAIRING_REQUIRED" || String(error).includes("PAIRING_REQUIRED");
}

async function approveNodePairing(operator: GatewayClient, nodeId: string): Promise<void> {
  const nodeRequestId = await waitUntil(async () => {
    const result = await operator.request<{
      pending?: Array<{ requestId?: string; nodeId?: string }>;
    }>("node.pair.list", {});
    return result.pending?.find((entry) => entry.nodeId === nodeId)?.requestId;
  });
  await operator.request("node.pair.approve", { requestId: nodeRequestId });
}

async function approvePairing(operator: GatewayClient, nodeId: string): Promise<void> {
  const deviceRequestId = await waitUntil(async () => {
    const result = await operator.request<{
      pending?: Array<{ requestId?: string; deviceId?: string; role?: string }>;
    }>("device.pair.list", {});
    return result.pending?.find((entry) => entry.deviceId === nodeId || entry.role === "node")
      ?.requestId;
  });
  await operator.request("device.pair.approve", { requestId: deviceRequestId });
  await approveNodePairing(operator, nodeId);
}

async function ensureNodeApproved(operator: GatewayClient, nodeId: string): Promise<boolean> {
  const approvalState = await waitUntil(async () => {
    const result = await operator.request<{ nodes?: WireNodeRead[] }>("node.list", {});
    return result.nodes?.find((node) => node.nodeId === nodeId)?.approvalState;
  });
  if (approvalState !== "approved") {
    await approveNodePairing(operator, nodeId);
    return true;
  }
  return false;
}

async function waitForApprovedWireNode(
  operator: GatewayClient,
  nodeId: string,
): Promise<WireNodeRead> {
  return await waitUntil(async () => {
    const result = await operator.request<{ nodes?: WireNodeRead[] }>("node.list", {});
    const approved = result.nodes?.find((node) => node.nodeId === nodeId);
    return approved?.approvalState === "approved" &&
      approved.connected === true &&
      approved.paired === true &&
      approved.sessionHost === true
      ? approved
      : undefined;
  });
}

type WireWorkerHostOptions = {
  gateway: WireGateway;
  operator: GatewayClient;
  root: string;
  label?: string;
  capacity?: number;
  capacityWaitMs?: number;
  containerEngine?: NodeWorkerContainerEngine;
  containerImage?: string;
  workerGatewayUrl?: string;
  workerEnv?: NodeJS.ProcessEnv;
  bundlePrewarm?: boolean;
  bundleRetention?: boolean;
  bundleStatus?: boolean;
  environmentSession?: boolean;
  onInvoke?: (frame: NodeInvokeRequestPayload) => void;
  afterInvoke?: (frame: NodeInvokeRequestPayload, host: PairedNodeWorkerHost) => Promise<void>;
};

export type PairedNodeWorkerHost = {
  readonly identity: DeviceIdentity;
  readonly commands: string[];
  readonly frames: NodeInvokeRequestPayload[];
  readonly invokeErrors: unknown[];
  readonly supervisor: ReturnType<typeof createNodeWorkerSupervisor>;
  readonly bundleInstaller: NodeWorkerBundleInstaller;
  readonly workspace: NodeWorkerWorkspaceRuntime;
  readonly client: GatewayClient | undefined;
  connect(options?: { environmentSession?: boolean }): Promise<void>;
  disconnect(): Promise<void>;
  publishInventory(): Promise<void>;
  waitForInvokes(): Promise<void>;
  waitForWorkersIdle(): Promise<void>;
  installedBundleDirectory(bundleHash: string): Promise<string>;
  stop(): Promise<void>;
};

export async function createPairedNodeWorkerHost(
  options: WireWorkerHostOptions,
): Promise<PairedNodeWorkerHost> {
  const label = options.label ?? "node";
  const nodeStateDir = path.join(options.root, `${label}-state`);
  const nodeHostRoot = path.join(nodeStateDir, "node-host");
  const nodeEnv = {
    ...process.env,
    HOME: path.join(options.root, `${label}-home`),
    NODE_DISABLE_COMPILE_CACHE: undefined,
    OPENCLAW_STATE_DIR: nodeStateDir,
    ...options.workerEnv,
  };
  await fs.mkdir(nodeEnv.HOME, { recursive: true });
  const workspace = new NodeWorkerWorkspaceRuntime({ root: nodeHostRoot, env: nodeEnv });
  const bundleInstaller = new NodeWorkerBundleInstaller({ root: nodeHostRoot, env: nodeEnv });
  let capacity = { total: options.capacity ?? 2, available: 0 };
  let environmentSession = options.environmentSession ?? true;
  let client: GatewayClient | undefined;
  let closing = false;
  const invokeTasks = new Set<Promise<void>>();
  const invokeErrors: unknown[] = [];
  const commands: string[] = [];
  const frames: NodeInvokeRequestPayload[] = [];
  const launchIds = new Set<string>();
  const identity = loadOrCreateDeviceIdentity({
    path: path.join(options.root, `${label}-identity.sqlite`),
  });

  const inventory = () => ({
    protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
    workerHost: {
      enabled: true as const,
      ...(environmentSession
        ? { environmentSession: NODE_WORKER_ENVIRONMENT_SESSION_VERSION }
        : {}),
      capacity,
      ...(options.bundlePrewarm ? { bundlePrewarm: WORKER_BUNDLE_PREWARM_VERSION } : {}),
      ...(options.bundleRetention ? { bundleRetention: NODE_WORKER_BUNDLE_RETENTION_VERSION } : {}),
      ...(options.bundleStatus ? { bundleStatus: NODE_WORKER_BUNDLE_STATUS_VERSION } : {}),
    },
  });

  const supervisor = createNodeWorkerSupervisor({
    env: nodeEnv,
    workspace,
    capacity: options.capacity,
    capacityWaitMs: options.capacityWaitMs,
    ...(options.containerEngine ? { containerEngine: options.containerEngine } : {}),
    ...(options.containerImage ? { containerImage: options.containerImage } : {}),
    onCapacityChanged: (nextCapacity) => {
      capacity = nextCapacity;
    },
  });

  const onEvent = (event: WireGatewayEvent) => {
    if (closing || event.event !== "node.invoke.request" || !client) {
      return;
    }
    const receiver = client;
    const frame = event.payload as NodeInvokeRequestPayload;
    commands.push(frame.command);
    frames.push(frame);
    if (frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND) {
      launchIds.add(parseNodeWorkerLaunchInput(frame.paramsJSON).launchId);
    }
    options.onInvoke?.(frame);
    const task = handleInvoke(frame, receiver, { current: async () => [] }, undefined, {
      workerBundleInstaller: bundleInstaller,
      workerSupervisor: supervisor,
      workerWorkspace: workspace,
      gatewayUrl:
        frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND
          ? (options.workerGatewayUrl ?? options.gateway.wsUrl)
          : options.gateway.wsUrl,
    })
      .then(async () => await options.afterInvoke?.(frame, host))
      .catch((error: unknown) => {
        invokeErrors.push(error);
      })
      .finally(() => invokeTasks.delete(task));
    invokeTasks.add(task);
  };

  const connect = async (connection?: { environmentSession?: boolean }) => {
    if (closing) {
      throw new Error("paired worker node is closing");
    }
    environmentSession = connection?.environmentSession ?? environmentSession;
    const open = () =>
      connectWireClient({
        gateway: options.gateway,
        role: "node",
        identity,
        onEvent,
      });
    let next: GatewayClient;
    try {
      next = await open();
    } catch (error) {
      if (!isPairingRequired(error)) {
        throw error;
      }
      await approvePairing(options.operator, identity.deviceId);
      next = await open();
    }
    client = next;
    if (await ensureNodeApproved(options.operator, identity.deviceId)) {
      await client.stopAndWait({ timeoutMs: 2_000 });
      client = await open();
    }
    await client.request(NODE_RUNNER_INVENTORY_UPDATE_METHOD, inventory());
  };
  const drainInvokeTasks = async () => {
    while (invokeTasks.size > 0) {
      await Promise.allSettled(invokeTasks);
    }
  };

  const host: PairedNodeWorkerHost = {
    identity,
    commands,
    frames,
    invokeErrors,
    supervisor,
    bundleInstaller,
    workspace,
    get client() {
      return client;
    },
    connect,
    async disconnect() {
      const current = client;
      client = undefined;
      await current?.stopAndWait({ timeoutMs: 2_000 });
    },
    async publishInventory() {
      if (!client) {
        throw new Error("paired worker node is disconnected");
      }
      await client.request(NODE_RUNNER_INVENTORY_UPDATE_METHOD, inventory());
    },
    async waitForInvokes() {
      await drainInvokeTasks();
    },
    async waitForWorkersIdle() {
      await waitUntil(async () => {
        const receipts = await Promise.all(
          [...launchIds].map(async (launchId) => await supervisor.status(launchId)),
        );
        // Finished turns do not prove the physical worker or container has been removed.
        return capacity.available === capacity.total &&
          receipts.every(
            (receipt) => receipt !== undefined && !["pending", "running"].includes(receipt.state),
          )
          ? true
          : undefined;
      });
    },
    async installedBundleDirectory(bundleHash) {
      const namespaces = await fs.readdir(nodeHostRoot, { withFileTypes: true });
      const matches: string[] = [];
      for (const entry of namespaces) {
        if (!entry.isDirectory()) {
          continue;
        }
        const candidate = path.join(nodeHostRoot, entry.name, "bundles", bundleHash);
        try {
          if ((await fs.stat(candidate)).isDirectory()) {
            matches.push(candidate);
          }
        } catch {
          // This namespace does not own the proof bundle.
        }
      }
      if (matches.length !== 1) {
        throw new Error(`expected one proof-owned installed bundle, found ${matches.length}`);
      }
      return matches[0]!;
    },
    async stop() {
      closing = true;
      const current = client;
      client = undefined;
      const connectionCleanup = await Promise.allSettled([
        current?.stopAndWait({ timeoutMs: 2_000 }) ?? Promise.resolve(),
      ]);
      await drainInvokeTasks();
      const cleanup = await Promise.allSettled([supervisor.close()]);
      const failures = [...connectionCleanup, ...cleanup].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "paired node worker cleanup failed");
      }
    },
  };

  await supervisor.initialize();
  await connect();
  await waitForApprovedWireNode(options.operator, identity.deviceId);
  return host;
}

export async function startPairedNodeWorkerGateway(params: {
  providerBaseUrl: string;
  executionIdentity?: boolean;
  repoRoot?: string;
  useRepoCli?: boolean;
  workspaceDir?: string;
  controlUiEnabled?: boolean;
  fullAccess?: boolean;
}): Promise<WireGateway> {
  return await startQaGatewayChild({
    repoRoot: params.repoRoot ?? process.cwd(),
    useRepoCli: params.useRepoCli ?? true,
    providerBaseUrl: `${params.providerBaseUrl}/v1`,
    providerMode: "mock-openai",
    primaryModel: MODEL_REF,
    alternateModel: MODEL_REF,
    transportBaseUrl: "http://127.0.0.1",
    controlUiEnabled: params.controlUiEnabled ?? false,
    mutateConfig: (config) => ({
      ...config,
      agents: {
        ...config.agents,
        defaults: {
          ...config.agents?.defaults,
          ...(params.workspaceDir ? { workspace: params.workspaceDir } : {}),
          subagents: {
            ...config.agents?.defaults?.subagents,
            maxSpawnDepth: 2,
          },
        },
      },
      logging: params.executionIdentity
        ? {
            ...config.logging,
            audit: { ...config.logging?.audit, enabled: true, executionIdentity: true },
          }
        : config.logging,
      ...(params.fullAccess
        ? {
            tools: {
              ...config.tools,
              exec: { ...config.tools?.exec, mode: "full" as const },
            },
          }
        : {}),
      nodeHost: {
        ...config.nodeHost,
        workerRuns: { enabled: true },
      },
    }),
  });
}

export function wireMessageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .flatMap((part) =>
          part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
            ? [(part as { text: string }).text]
            : [],
        )
        .join("")
    : "";
}

export function bundleInstallFrames(host: PairedNodeWorkerHost): NodeInvokeRequestPayload[] {
  return host.frames.filter((frame) => frame.command === NODE_WORKER_BUNDLE_INSTALL_COMMAND);
}
