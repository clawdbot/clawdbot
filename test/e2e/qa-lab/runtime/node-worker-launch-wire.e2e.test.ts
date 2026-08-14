import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import { WORKER_PROTOCOL_FEATURES } from "../../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { DeviceIdentity } from "../../../../src/infra/device-identity.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import {
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../../../src/infra/node-commands.js";
import {
  NODE_RUNNER_INVENTORY_UPDATE_METHOD,
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
} from "../../../../src/infra/node-runner-inventory.js";
import { handleInvoke, type NodeInvokeRequestPayload } from "../../../../src/node-host/invoke.js";
import {
  resolveNodeWorkerInstallation,
  type NodeWorkerInstallation,
} from "../../../../src/node-host/node-worker-build.js";
import { createNodeWorkerSupervisor } from "../../../../src/node-host/node-worker-supervisor.js";
import { NodeWorkerWorkspaceRuntime } from "../../../../src/node-host/node-worker-workspace.js";
import { VERSION } from "../../../../src/version.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  BASELINE_PROMPT,
  BASELINE_REPLY,
  MODEL_REF,
  PROOF_TIMEOUT_MS,
  startMidturnProvider,
} from "./cloud-worker-midturn-loss-fixture.js";

const execFileAsync = promisify(execFile);
const SESSION_KEY = "agent:qa:node-worker-launch-wire";
const NODE_DISPLAY_NAME = "QA local-install worker node";
const TEST_TIMEOUT_MS = PROOF_TIMEOUT_MS + 60_000;

type Gateway = Awaited<ReturnType<typeof startQaGatewayChild>>;
type GatewayEvent = { event: string; payload?: unknown };
type NodeRead = {
  nodeId: string;
  approvalState?: string;
  connected?: boolean;
  paired?: boolean;
  sessionHost?: boolean;
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return stdout.trim();
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createPublishedWorkspace(root: string) {
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

async function createSourceWorkerInstallation(root: string): Promise<NodeWorkerInstallation> {
  const packageRoot = path.join(root, "local-install");
  const repoRoot = process.cwd();
  await fs.mkdir(packageRoot, { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(repoRoot, "openclaw.mjs"), path.join(packageRoot, "openclaw.mjs")),
    fs.copyFile(path.join(repoRoot, "package.json"), path.join(packageRoot, "package.json")),
    fs.cp(path.join(repoRoot, "dist"), path.join(packageRoot, "dist"), { recursive: true }),
  ]);
  await fs.chmod(path.join(packageRoot, "openclaw.mjs"), 0o700);
  await fs.symlink(
    path.join(repoRoot, "node_modules"),
    path.join(packageRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return await resolveNodeWorkerInstallation({
    packageRoot,
    openclawVersion: VERSION,
    protocolFeatures: WORKER_PROTOCOL_FEATURES,
  });
}

async function connectClient(params: {
  gateway: Gateway;
  role: "operator" | "node";
  identity: DeviceIdentity | null;
  workerRuns?: NodeWorkerInstallation["build"];
  onEvent?: (event: GatewayEvent) => void;
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
      30_000,
    );
    timeout.unref();
    const node = params.role === "node";
    const client = new GatewayClient({
      url: params.gateway.wsUrl,
      token: params.gateway.token,
      env: params.gateway.runtimeEnv,
      role: params.role,
      clientName: node ? GATEWAY_CLIENT_NAMES.NODE_HOST : GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: node ? NODE_DISPLAY_NAME : "Node worker launch wire operator",
      clientVersion: VERSION,
      platform: node ? "macos" : process.platform,
      deviceFamily: node ? "Mac" : undefined,
      mode: node ? GATEWAY_CLIENT_MODES.NODE : GATEWAY_CLIENT_MODES.BACKEND,
      scopes: node ? [] : ["operator.admin", "operator.pairing", "operator.read", "operator.write"],
      caps: node ? ["system"] : undefined,
      commands: node ? [] : undefined,
      workerRuns: params.workerRuns,
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

async function approvePairing(operator: GatewayClient, nodeId: string): Promise<void> {
  let deviceRequestId: string | undefined;
  await vi.waitFor(
    async () => {
      const result = await operator.request<{
        pending?: Array<{ requestId?: string; deviceId?: string; role?: string }>;
      }>("device.pair.list", {});
      deviceRequestId = result.pending?.find(
        (entry) => entry.deviceId === nodeId || entry.role === "node",
      )?.requestId;
      expect(deviceRequestId).toBeTruthy();
    },
    { timeout: 30_000, interval: 100 },
  );
  await operator.request("device.pair.approve", { requestId: deviceRequestId });

  await approveNodePairing(operator, nodeId);
}

async function approveNodePairing(operator: GatewayClient, nodeId: string): Promise<void> {
  let nodeRequestId: string | undefined;
  await vi.waitFor(
    async () => {
      const result = await operator.request<{
        pending?: Array<{ requestId?: string; nodeId?: string }>;
      }>("node.pair.list", {});
      nodeRequestId = result.pending?.find((entry) => entry.nodeId === nodeId)?.requestId;
      expect(nodeRequestId).toBeTruthy();
    },
    { timeout: 30_000, interval: 100 },
  );
  await operator.request("node.pair.approve", { requestId: nodeRequestId });
}

async function ensureNodeApproved(operator: GatewayClient, nodeId: string): Promise<boolean> {
  let approvalState: string | undefined;
  await vi.waitFor(
    async () => {
      const result = await operator.request<{ nodes?: NodeRead[] }>("node.list", {});
      approvalState = result.nodes?.find((node) => node.nodeId === nodeId)?.approvalState;
      expect(approvalState).toBeTruthy();
    },
    { timeout: 30_000, interval: 100 },
  );
  if (approvalState !== "approved") {
    await approveNodePairing(operator, nodeId);
    return true;
  }
  return false;
}

async function connectPairedNode(params: {
  gateway: Gateway;
  operator: GatewayClient;
  identity: DeviceIdentity;
  installation: NodeWorkerInstallation;
  onEvent: (event: GatewayEvent) => void;
}): Promise<GatewayClient> {
  const connect = () =>
    connectClient({
      gateway: params.gateway,
      role: "node",
      identity: params.identity,
      workerRuns: params.installation.build,
      onEvent: params.onEvent,
    });
  let client: GatewayClient;
  try {
    client = await connect();
  } catch (error) {
    if (!isPairingRequired(error)) {
      throw error;
    }
    await approvePairing(params.operator, params.identity.deviceId);
    client = await connect();
  }
  if (await ensureNodeApproved(params.operator, params.identity.deviceId)) {
    await client.stopAndWait({ timeoutMs: 2_000 });
    client = await connect();
  }
  await client.request(NODE_RUNNER_INVENTORY_UPDATE_METHOD, {
    protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
    workerRuns: params.installation.build,
  });
  return client;
}

async function waitForApprovedNode(operator: GatewayClient, nodeId: string): Promise<NodeRead> {
  let approved: NodeRead | undefined;
  await vi.waitFor(
    async () => {
      const result = await operator.request<{ nodes?: NodeRead[] }>("node.list", {});
      approved = result.nodes?.find((node) => node.nodeId === nodeId);
      expect(approved).toMatchObject({
        nodeId,
        approvalState: "approved",
        connected: true,
        paired: true,
        sessionHost: true,
      });
    },
    { timeout: 30_000, interval: 100 },
  );
  if (!approved) {
    throw new Error("paired worker node did not become available");
  }
  return approved;
}

function messageText(message: unknown): string {
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

describe("node worker launch wire", () => {
  it(
    "transfers and reconciles a gateway-push workspace through a device runner",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const root = tempDirs.make("openclaw-node-worker-launch-wire-");
      const provider = await startMidturnProvider();
      const published = await createPublishedWorkspace(root);
      const installation = await createSourceWorkerInstallation(root);
      const nodeEnv = {
        ...process.env,
        HOME: path.join(root, "node-home"),
        OPENCLAW_STATE_DIR: path.join(root, "node-state"),
      };
      await fs.mkdir(nodeEnv.HOME, { recursive: true });
      const supervisor = createNodeWorkerSupervisor({
        env: nodeEnv,
        localInstallation: installation,
      });
      const workspace = new NodeWorkerWorkspaceRuntime({
        root: path.join(root, "node-workspaces"),
        env: nodeEnv,
      });
      let gateway: Gateway | undefined;
      let operator: GatewayClient | undefined;
      let node: GatewayClient | undefined;
      let closing = false;
      let reconnected = false;
      const invokeTasks = new Set<Promise<void>>();
      const invokeErrors: unknown[] = [];
      const commands: string[] = [];
      let launchId: string | undefined;

      try {
        gateway = await startQaGatewayChild({
          repoRoot: process.cwd(),
          useRepoCli: true,
          providerBaseUrl: `${provider.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL_REF,
          alternateModel: MODEL_REF,
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          mutateConfig: (config) => ({
            ...config,
            nodeHost: {
              ...config.nodeHost,
              workerRuns: { enabled: true },
            },
          }),
        });
        operator = await connectClient({ gateway, role: "operator", identity: null });
        const identity = loadOrCreateDeviceIdentity({
          path: path.join(root, "node-identity.sqlite"),
        });
        const onNodeEvent = (event: GatewayEvent) => {
          if (event.event !== "node.invoke.request" || !node) {
            return;
          }
          const receiver = node;
          const frame = event.payload as NodeInvokeRequestPayload;
          commands.push(frame.command);
          if (frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND && frame.paramsJSON) {
            launchId = (JSON.parse(frame.paramsJSON) as { launchId?: string }).launchId;
          }
          const task = handleInvoke(frame, receiver, { current: async () => [] }, undefined, {
            workerSupervisor: supervisor,
            workerWorkspace: workspace,
            gatewayUrl: gateway!.wsUrl,
          })
            .then(async () => {
              if (
                frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND &&
                !reconnected &&
                !closing
              ) {
                reconnected = true;
                await receiver.stopAndWait({ timeoutMs: 2_000 });
                if (!closing) {
                  node = await connectPairedNode({
                    gateway: gateway!,
                    operator: operator!,
                    identity,
                    installation,
                    onEvent: onNodeEvent,
                  });
                }
              }
            })
            .catch((error: unknown) => {
              invokeErrors.push(error);
            })
            .finally(() => invokeTasks.delete(task));
          invokeTasks.add(task);
        };
        node = await connectPairedNode({
          gateway,
          operator,
          identity,
          installation,
          onEvent: onNodeEvent,
        });
        const listed = await waitForApprovedNode(operator, identity.deviceId);
        expect(listed.sessionHost).toBe(true);

        await operator.request("sessions.create", {
          key: SESSION_KEY,
          agentId: "qa",
          worktree: true,
          worktreeName: "node-worker-launch-wire",
          worktreeBaseRef: "main",
          cwd: published.source,
        });
        const created = (await gateway.call("sessions.describe", { key: SESSION_KEY })) as {
          session?: { execCwd?: string; spawnedCwd?: string };
        };
        const localWorkspaceDir = created.session?.execCwd ?? created.session?.spawnedCwd;
        expect(localWorkspaceDir).toBeTruthy();
        await fs.writeFile(
          path.join(localWorkspaceDir!, "gateway-push.txt"),
          "dirty gateway workspace\n",
        );
        const dispatched = await gateway.call(
          "sessions.dispatch",
          { key: SESSION_KEY, deviceId: identity.deviceId },
          { timeoutMs: PROOF_TIMEOUT_MS },
        );
        const placement = (dispatched as { placement?: Record<string, unknown> }).placement;
        expect(placement).toMatchObject({
          state: "active",
          workerBundleHash: installation.build.bundleHash,
        });
        const remoteWorkspaceDir = String(placement?.remoteWorkspaceDir ?? "");
        const baseManifestRef = placement?.workspaceBaseManifestRef;
        await expect(
          fs.readFile(path.join(remoteWorkspaceDir, "gateway-push.txt"), "utf8"),
        ).resolves.toBe("dirty gateway workspace\n");
        await expect(
          fs.readFile(path.join(remoteWorkspaceDir, "nested", "tracked.txt"), "utf8"),
        ).resolves.toBe("nested tracked input\n");
        await fs.writeFile(path.join(remoteWorkspaceDir, "node-result.txt"), "device result\n");

        const runId = `node-worker-launch-wire-${Date.now()}`;
        const started = await operator.request<{ runId?: string; status?: string }>("chat.send", {
          sessionKey: SESSION_KEY,
          message: BASELINE_PROMPT,
          deliver: false,
          idempotencyKey: runId,
        });
        expect(started).toMatchObject({ runId, status: "started" });
        const completed = await operator.request<{ status?: string }>(
          "agent.wait",
          { runId, timeoutMs: PROOF_TIMEOUT_MS },
          { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
        );
        if (completed.status !== "ok") {
          throw new Error(
            `node worker turn failed: ${JSON.stringify(completed)}\n${gateway.logs().slice(-12_000)}`,
          );
        }
        await Promise.all([...invokeTasks]);
        expect(invokeErrors).toEqual([]);
        expect(reconnected).toBe(true);
        expect(commands).toContain(NODE_WORKER_WORKSPACE_EXEC_COMMAND);
        expect(commands).toContain(NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND);
        expect(commands).toContain(NODE_WORKER_SUPERVISOR_STATUS_COMMAND);
        expect(launchId).toBeTruthy();
        await expect(supervisor.status(launchId!)).resolves.toMatchObject({ state: "completed" });

        const history = await operator.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey: SESSION_KEY,
          limit: 20,
        });
        expect(
          history.messages?.filter(
            (message) =>
              (message as { role?: unknown }).role === "assistant" &&
              messageText(message).includes(BASELINE_REPLY),
          ),
        ).toHaveLength(1);
        const described = (await gateway.call("sessions.describe", { key: SESSION_KEY })) as {
          session?: { execCwd?: string; spawnedCwd?: string; placement?: Record<string, unknown> };
        };
        expect(described.session?.placement).toMatchObject({
          state: "active",
          remoteWorkspaceDir,
        });
        expect(described.session?.placement?.workspaceBaseManifestRef).not.toBe(baseManifestRef);
        const reconciledLocalDir = described.session?.execCwd ?? described.session?.spawnedCwd;
        expect(reconciledLocalDir).toBeTruthy();
        await expect(
          fs.readFile(path.join(reconciledLocalDir!, "node-result.txt"), "utf8"),
        ).resolves.toBe("device result\n");
        expect(await git(remoteWorkspaceDir, "rev-parse", "HEAD")).toBe(published.commit);
        expect(await fs.readFile(path.join(remoteWorkspaceDir, "node-result.txt"), "utf8")).toBe(
          "device result\n",
        );
      } finally {
        closing = true;
        const cleanup = await Promise.allSettled([
          node?.stopAndWait({ timeoutMs: 2_000 }) ?? Promise.resolve(),
          operator?.stopAndWait({ timeoutMs: 2_000 }) ?? Promise.resolve(),
          Promise.allSettled([...invokeTasks]),
          supervisor.close(),
          gateway?.stop() ?? Promise.resolve(),
          provider.stop(),
          closeServer(published.server),
        ]);
        const failures = cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "node worker launch wire cleanup failed");
        }
      }
    },
  );
});
