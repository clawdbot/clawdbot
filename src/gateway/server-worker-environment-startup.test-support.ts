import { execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { Value } from "typebox/value";
import { expect, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { NodeInvokeResultParamsSchema } from "../../packages/gateway-protocol/src/schema/nodes.js";
import { requireGit } from "../agents/worktrees/git.js";
import { NODE_WORKER_WORKSPACE_PREPARE_COMMAND } from "../infra/node-commands.js";
import {
  NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
  NODE_WORKER_WORKSPACE_MANIFEST_VERSION,
} from "../infra/node-runner-inventory.js";
import type { NodeHostClient } from "../node-host/client.js";
import {
  coerceNodeInvokePayload,
  coerceNodeInvokeCancelPayload,
} from "../node-host/invoke-payload.js";
import { handleInvoke, type NodeInvokeRequestPayload } from "../node-host/invoke.js";
import { NodeWorkerPreparedWorkspaceStore } from "../node-host/node-worker-prepared-workspace-store.js";
import { NodeWorkerWorkspaceRuntime } from "../node-host/node-worker-workspace.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { parseNodeWorkerPreparedWorkspaceResult } from "../worker/node-workspace-prepared-protocol.js";
import { createDesktopSessionRegistry } from "./desktop/session-registry.js";
import { createNodeRegistryRuntime, updateNodeRunnerInventory } from "./node-registry-private.js";
import { NodeRegistry } from "./node-registry.js";
import {
  createGatewayWorkerEnvironmentRuntime,
  loadGatewayWorkerEnvironmentStartupState,
} from "./server-worker-environment-startup.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";
import { createProjectSetupScript } from "./worker-environments/project-setup-script.js";
import * as serviceModule from "./worker-environments/service.js";

async function createPreparedNodeAcknowledgement(root: string, reserveRemainingMs?: number) {
  const home = path.join(root, "node-home");
  await fs.mkdir(home);
  const startup = await loadGatewayWorkerEnvironmentStartupState();
  const factory = vi.spyOn(serviceModule, "createWorkerEnvironmentService");
  const registry = createEmptyPluginRegistry();
  const owned: {
    runtime?: Awaited<ReturnType<typeof createGatewayWorkerEnvironmentRuntime>>;
    nodeRegistry?: NodeRegistry;
    server?: WebSocketServer;
    client?: WebSocket;
  } = {};
  const pending = new Set<Promise<void>>();
  const connId = "prepared-wire-connection";
  const controllers = new Map<string, AbortController>();
  const cancelled = createDeferredCore<string>();
  const close = async () => {
    owned.nodeRegistry?.unregister(connId);
    for (const controller of controllers.values()) {
      controller.abort();
    }
    owned.client?.terminate();
    const server = owned.server;
    for (const socket of server?.clients ?? []) {
      socket.terminate();
    }
    await Promise.all([
      ...pending,
      server
        ? new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          })
        : undefined,
      owned.runtime?.workerEnvironmentService?.stop(),
    ]);
  };
  try {
    const runtime = await createGatewayWorkerEnvironmentRuntime({
      getPluginRegistry: () => registry,
      getPortalRuntime: () => undefined,
      resolveGatewayContext: () => undefined,
      desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
      startup,
      log: { child: () => ({ warn: () => {} }) },
    });
    owned.runtime = runtime;
    const options = factory.mock.calls.at(-1)?.[0];
    if (
      !options?.registerPreparedWorkspace ||
      !options.bindPreparedWorkspace ||
      !options.projectNamespace
    ) {
      throw new Error("Prepared workspace callbacks were not composed");
    }
    const namespace = options.projectNamespace;
    const preparationKey = "a".repeat(64);
    const cacheKey = "c".repeat(64);
    const seedKey = "b".repeat(64);
    const seed = path.join(home, ".openclaw-worker", "git-seeds", namespace, seedKey);
    await fs.mkdir(seed, { recursive: true });
    await requireGit(seed, ["init", "--quiet"]);
    await fs.writeFile(path.join(seed, "source.txt"), "pristine source\n");
    await requireGit(seed, ["add", "."]);
    await requireGit(seed, [
      "-c",
      "user.name=Prepared Test",
      "-c",
      "user.email=prepared@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "source",
    ]);
    const baseCommit = (await requireGit(seed, ["rev-parse", "HEAD"])).trim();
    const output = execFileSync(
      "sh",
      [
        "-c",
        createProjectSetupScript({ namespace, seedKey, preparationKey, cacheKey, baseCommit }),
      ],
      {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const environmentId = "prepared-wire-environment";
    const prepared = parseNodeWorkerPreparedWorkspaceResult({
      ...JSON.parse(output),
      gatewayNamespace: namespace,
      environmentId,
      preparationKey,
      cacheKey,
    });
    if (!prepared) {
      throw new Error("Project setup did not produce a valid workspace");
    }
    const env = { ...process.env, HOME: home, OPENCLAW_STATE_DIR: path.join(root, "node-state") };
    const workspace = new NodeWorkerWorkspaceRuntime({ env, ephemeral: true });
    const preparedStore = new NodeWorkerPreparedWorkspaceStore({ env });
    const nodeId = "prepared-wire-node";
    const { nodeRegistry, nodeWorkerSupervisorTransport } = createNodeRegistryRuntime(
      () => new NodeRegistry(),
    );
    owned.nodeRegistry = nodeRegistry;
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    owned.server = server;
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected loopback listener");
    }
    const connected = new Promise<WebSocket>((resolve) => {
      server.once("connection", resolve);
    });
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    owned.client = client;
    await once(client, "open");
    const socket = await connected;
    nodeRegistry.register(
      {
        connId,
        socket,
        usesSharedGatewayAuth: false,
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: GATEWAY_CLIENT_IDS.NODE_HOST,
            version: "test",
            platform: "test",
            mode: "node",
          },
          device: {
            id: nodeId,
            publicKey: "fixture",
            signature: "fixture",
            signedAt: 1,
            nonce: "fixture",
          },
          commands: [],
        },
      },
      { pairingIdentity: "fixture-pairing", pairingGeneration: "fixture-generation" },
    );
    const setWorkspaceManifest = (available: boolean) =>
      updateNodeRunnerInventory({
        registry: nodeRegistry,
        nodeId,
        connId,
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: {
            enabled: true,
            capacity: { total: 1, available: 1 },
            environmentSession: 1,
            ...(available ? { workspaceManifest: NODE_WORKER_WORKSPACE_MANIFEST_VERSION } : {}),
          },
        },
      });
    setWorkspaceManifest(true);
    const received: Array<Parameters<NodeRegistry["handleInvokeResult"]>[0]> = [];
    const accepted: boolean[] = [];
    const invoked: NodeInvokeRequestPayload[] = [];
    let beforeReply: (() => Promise<void>) | undefined;
    // Node replies use the real handler serializer and registry result owner;
    // only the outbound invoke request traverses the loopback WebSocket.
    function request<T>(...args: Parameters<NodeHostClient["request"]>): Promise<T>;
    async function request(_method: string, params?: unknown): Promise<unknown> {
      if (!Value.Check(NodeInvokeResultParamsSchema, params)) {
        throw new Error("Node sent an invalid result envelope");
      }
      await beforeReply?.();
      received.push({ ...params, connId });
      accepted.push(nodeRegistry.handleInvokeResult({ ...params, connId }));
      return null;
    }
    client.on("message", (data) => {
      const frame = JSON.parse(rawDataToString(data)) as {
        event: string;
        payload: unknown;
      };
      if (frame.event === "node.invoke.cancel") {
        const cancellation = coerceNodeInvokeCancelPayload(frame.payload);
        if (cancellation) {
          controllers.get(cancellation.invokeId)?.abort();
          cancelled.resolve(cancellation.invokeId);
        }
        return;
      }
      if (frame.event !== "node.invoke.request") {
        return;
      }
      const input = coerceNodeInvokePayload(frame.payload);
      if (!input) {
        throw new Error("Node received an invalid invoke frame");
      }
      expect(input.command).toBe(NODE_WORKER_WORKSPACE_PREPARE_COMMAND);
      invoked.push(input);
      const controller = new AbortController();
      controllers.set(input.id, controller);
      const invocation = handleInvoke(input, { request }, { current: async () => [] }, undefined, {
        workerWorkspace: workspace,
        signal: controller.signal,
      });
      pending.add(invocation);
      void invocation.finally(() => {
        pending.delete(invocation);
        controllers.delete(input.id);
      });
    });
    runtime.bindDeviceNodeControl?.(nodeWorkerSupervisorTransport);
    startup.store.createIntent({
      environmentId,
      providerId: "fake",
      profileId: "prepared",
      profileSnapshot: { settings: {} },
      provisionOperationId: "prepared-wire",
      ...(reserveRemainingMs === undefined
        ? {}
        : {
            preparation: {
              key: preparationKey,
              demandAtMs: Date.now(),
              expiresAtMs: Date.now() + reserveRemainingMs,
            },
          }),
    });
    const record = startup.store.transition({
      environmentId,
      from: "requested",
      to: "provisioning",
      patch: { nodeDeviceId: nodeId },
    });

    const register = (signal?: AbortSignal) =>
      options.registerPreparedWorkspace!({
        record,
        deviceId: nodeId,
        workspace: {
          preparationKey,
          cacheKey,
          workspaceDir: prepared.workspaceDir,
          homeDir: prepared.homeDir,
          sourceManifestRef: prepared.sourceManifestRef,
        },
        assertCurrent: () => {},
        signal,
      });
    const makeReady = () => {
      startup.store.transition({
        environmentId,
        from: "provisioning",
        to: "ready",
        patch: {
          leaseId: "prepared-wire-lease",
          nodeDeviceId: nodeId,
          sharedHost: false,
          bootstrapReceipt: {
            bundleHash: "a".repeat(64),
            openclawVersion: "2026.8.1",
            protocolFeatures: [],
            installKind: "bundle",
          },
          credential: {
            credentialHash: hashWorkerCredential("prepared-ack-credential"),
            sessionId: null,
            rpcSetVersion: 1,
            expiresAtMs: Date.now() + 60_000,
          },
        },
      });
    };
    const binding = {
      environmentId,
      preparationKey,
      cacheKey,
      ownerEpoch: 1,
      sessionId: "prepared-session",
      sessionKey: "agent:main:prepared",
      assertCurrent: () => {},
    };

    return {
      prepared,
      record,
      workspace,
      preparedStore,
      received,
      accepted,
      invoked,
      cancelled,
      setWorkspaceManifest,
      register,
      makeReady,
      bind: (signal?: AbortSignal) => options.bindPreparedWorkspace!({ ...binding, signal }),
      binding,
      holdReply: (gate: () => Promise<void>) => {
        beforeReply = gate;
      },
      settleInvokes: () => Promise.all(pending),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function withPreparedNodeAcknowledgement(
  root: string,
  run: (fixture: Awaited<ReturnType<typeof createPreparedNodeAcknowledgement>>) => Promise<void>,
  reserveRemainingMs?: number,
) {
  await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "gateway-state") }, async () => {
    const fixture = await createPreparedNodeAcknowledgement(root, reserveRemainingMs);
    try {
      await run(fixture);
    } finally {
      await fixture.close();
    }
  });
}
