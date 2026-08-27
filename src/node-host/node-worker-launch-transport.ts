import { isGatewayLoopbackHost } from "../../packages/gateway-client/src/websocket-transport.js";
import { createChildAdapter } from "../process/supervisor/adapters/child.js";
import type { WorkerLaunchDescriptor } from "../worker/launch-descriptor.js";
import { parseNodeWorkerConnectionFailureMessage } from "../worker/node-supervisor-protocol.js";
import type { WorkerProcessInput } from "../worker/worker-process-protocol.js";
import {
  buildNodeWorkerContainerStartArgv,
  createNodeWorkerContainer,
  type NodeWorkerContainerEngine,
} from "./node-worker-container-engine.js";
import type { NodeWorkerContainerLifecycle } from "./node-worker-container-lifecycle.js";
import { resolveNodeWorkerEntry } from "./node-worker-entry.js";
import type {
  NodeWorkerContainerIdentity,
  NodeWorkerLaunchReceipt,
  NodeWorkerLaunchStore,
} from "./node-worker-launch-store.js";
import {
  sanitizeNodeWorkerDiagnostic,
  type NodeWorkerCredentialScrubber,
} from "./node-worker-output.js";
import type { NodeWorkerLaunchInput } from "./node-worker-supervisor-contract.js";

export type NodeWorkerChildAdapter = Awaited<ReturnType<typeof createChildAdapter>>;

type NodeWorkerLaunchTransportOptions = {
  bundleRoot: string;
  workerEnv: NodeJS.ProcessEnv;
  engineEnv: NodeJS.ProcessEnv;
  input: NodeWorkerLaunchInput;
  descriptor: WorkerLaunchDescriptor;
  connectionFailure: { errorText?: string };
  scrubber: NodeWorkerCredentialScrubber;
  store: NodeWorkerLaunchStore;
  containerEngine?: NodeWorkerContainerEngine;
  containerLifecycle?: NodeWorkerContainerLifecycle;
  containerImage?: string;
};

type NodeWorkerLaunchTransport =
  | { kind: "terminal"; receipt: NodeWorkerLaunchReceipt }
  | {
      kind: "started";
      adapter: NodeWorkerChildAdapter;
      container?: NodeWorkerContainerIdentity;
    };

/** Keep local IPC and container stdio as transport choices of one launch state machine. */
export async function prepareNodeWorkerLaunchTransport(
  options: NodeWorkerLaunchTransportOptions,
): Promise<NodeWorkerLaunchTransport> {
  const entry = resolveNodeWorkerEntry({
    bundleRoot: options.bundleRoot,
    expectedBundleHash: options.input.expectedBundleHash,
    gatewayNamespace: options.input.gatewayNamespace,
  });
  if (!options.containerEngine) {
    return {
      kind: "started",
      adapter: await createChildAdapter({
        argv: [process.execPath, entry, "--internal-worker-ipc", "--internal-worker-session"],
        env: options.workerEnv,
        exactEnv: true,
        ownedWorker: true,
        onWorkerMessage: (message) => {
          const diagnostic = parseNodeWorkerConnectionFailureMessage(message);
          if (!diagnostic) {
            return;
          }
          options.connectionFailure.errorText = diagnostic.cause
            ? sanitizeNodeWorkerDiagnostic(
                diagnostic.cause,
                "node worker gateway connection failed",
                options.scrubber.scrub,
              )
            : undefined;
        },
        stdinMode: "pipe-open",
      }),
    };
  }

  const endpoint = options.descriptor.connectionEndpoint;
  if (endpoint.kind !== "websocket") {
    throw new Error("container-isolated workers require a reachable WebSocket Gateway URL");
  }
  if (isGatewayLoopbackHost(new URL(endpoint.url).hostname)) {
    throw new Error(
      "container-isolated workers cannot reach a loopback Gateway URL; connect the node host using a Gateway address reachable from its container network",
    );
  }
  if (options.descriptor.assignment.browser) {
    throw new Error(
      "container-isolated workers cannot use host browser assignments; disable browser access for isolated worker sessions",
    );
  }

  const lifecycle = options.containerLifecycle;
  if (!lifecycle) {
    throw new Error("node worker container isolation has no lifecycle owner");
  }
  let container: NodeWorkerContainerIdentity | undefined;
  try {
    container = await createNodeWorkerContainer(options.containerEngine, {
      bundleRoot: options.bundleRoot,
      bundleEntry: entry,
      workspaceDir: options.descriptor.assignment.workspaceDir,
      gatewayNamespace: options.input.gatewayNamespace,
      launchId: options.input.launchId,
      env: options.workerEnv,
      ...(options.containerImage ? { image: options.containerImage } : {}),
    });
    const claimed = options.store.get(options.input.launchId);
    if (claimed?.state !== "pending") {
      await lifecycle.remove(container, options.input);
      if (!claimed) {
        throw new Error("node worker container launch lost its durable claim");
      }
      return { kind: "terminal", receipt: claimed };
    }
    const adapter = await createChildAdapter({
      argv: buildNodeWorkerContainerStartArgv(options.containerEngine, container.containerId),
      env: options.containerEngine.env ?? options.engineEnv,
      exactEnv: true,
      stdinMode: "pipe-open",
    });
    return { kind: "started", adapter, container };
  } catch (error) {
    if (container) {
      await lifecycle.remove(container, options.input);
    }
    throw error;
  }
}

/** Both transports admit turns only after the physical owner has been journaled. */
export async function startNodeWorkerLaunchTransport(params: {
  adapter: NodeWorkerChildAdapter;
  descriptor: WorkerLaunchDescriptor;
  container?: NodeWorkerContainerIdentity;
  isCurrent: () => boolean;
}): Promise<void> {
  if (!params.isCurrent()) {
    throw new Error("node worker admission closed before startup");
  }
  if (!params.container) {
    await params.adapter.openStartGate?.();
  }
  if (!params.isCurrent()) {
    throw new Error("node worker admission closed before descriptor dispatch");
  }
  await sendNodeWorkerInput(params.adapter, {
    type: "turn",
    turnId: params.descriptor.assignment.turnId,
    descriptor: params.descriptor,
  });
}

export async function sendNodeWorkerInput(
  adapter: NodeWorkerChildAdapter,
  message: WorkerProcessInput,
): Promise<void> {
  const stdin = adapter.stdin;
  if (!stdin) {
    throw new Error("node worker did not provide a writable stdin pipe");
  }
  await new Promise<void>((resolve, reject) => {
    stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
