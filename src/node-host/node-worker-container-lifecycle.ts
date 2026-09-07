import {
  inspectNodeWorkerContainer,
  killNodeWorkerContainer,
  listNodeWorkerContainers,
  type NodeWorkerContainerEngine,
} from "./node-worker-container-engine.js";
import type {
  NodeWorkerContainerIdentity,
  NodeWorkerLaunchStore,
} from "./node-worker-launch-store.js";
import { inspectNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";

type NodeWorkerContainerOwner = { gatewayNamespace: string; launchId: string };

export class NodeWorkerContainerContextMismatchError extends Error {}

/** Owns exact container authority and startup cleanup independently of client PIDs. */
export class NodeWorkerContainerLifecycle {
  constructor(
    private readonly engine: NodeWorkerContainerEngine,
    private readonly bundleRoot: string,
    private readonly store: NodeWorkerLaunchStore,
  ) {}

  async initialize(): Promise<void> {
    for (const receipt of this.store.listNonterminal()) {
      if (
        receipt.container &&
        (receipt.container.engine !== this.engine.id ||
          receipt.container.engineTarget !== this.engine.target)
      ) {
        throw new NodeWorkerContainerContextMismatchError(
          `node worker launch ${receipt.launchId} belongs to a different ${receipt.container.engine} engine or daemon; restore its original engine context before enabling worker hosting`,
        );
      }
    }

    // Pending claims can already own a created container. Sweep before capacity
    // finalizes stale claims, but preserve another live supervisor's startup.
    for (const container of await listNodeWorkerContainers(this.engine, {
      bundleRoot: this.bundleRoot,
    })) {
      const receipt = this.store.get(container.launchId);
      if (receipt?.state === "pending" && receipt.gatewayNamespace === container.gatewayNamespace) {
        const supervisorState = inspectNodeWorkerProcessIdentity(receipt.supervisor);
        if (supervisorState === "live" || supervisorState === "unknown") {
          continue;
        }
      }
      if (
        receipt?.state === "running" &&
        receipt.gatewayNamespace === container.gatewayNamespace &&
        receipt.container?.engine === container.engine &&
        receipt.container.containerId === container.containerId &&
        receipt.container.engineTarget === this.engine.target
      ) {
        continue;
      }
      await this.remove(container, container);
    }
  }

  async inspect(
    container: NodeWorkerContainerIdentity,
    owner: NodeWorkerContainerOwner,
  ): Promise<"live" | "dead" | "reused" | "unknown"> {
    return await inspectNodeWorkerContainer(
      this.requireMatchingEngine(container),
      container.containerId,
      this.expectedOwner(owner),
    );
  }

  async remove(
    container: NodeWorkerContainerIdentity,
    owner: NodeWorkerContainerOwner,
  ): Promise<void> {
    await killNodeWorkerContainer(
      this.requireMatchingEngine(container),
      container.containerId,
      this.expectedOwner(owner),
    );
  }

  private requireMatchingEngine(container: NodeWorkerContainerIdentity): NodeWorkerContainerEngine {
    if (container.engine !== this.engine.id || container.engineTarget !== this.engine.target) {
      throw new NodeWorkerContainerContextMismatchError(
        `node worker container belongs to a different ${container.engine} engine or daemon context`,
      );
    }
    return this.engine;
  }

  private expectedOwner(owner: NodeWorkerContainerOwner) {
    return { bundleRoot: this.bundleRoot, ...owner };
  }
}
