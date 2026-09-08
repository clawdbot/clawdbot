import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore } from "../shared/deferred.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";

type RequestEntryOptions = Pick<GatewayRequestOptions, "client" | "context"> & {
  req: Pick<GatewayRequestOptions["req"], "method" | "params">;
};

export type GatewayRequestEntry = {
  assertOpen: () => void;
  release: () => void;
};

function isPendingNodeCompletion({ req, client, context }: RequestEntryOptions): boolean {
  if (client?.connect.role !== "node" || !client.connId || !isRecord(req.params)) {
    return false;
  }
  const invokeId =
    req.method === "node.invoke.progress"
      ? req.params.invokeId
      : req.method === "node.invoke.result"
        ? req.params.id
        : undefined;
  return (
    typeof invokeId === "string" &&
    typeof req.params.nodeId === "string" &&
    context.nodeRegistry.isInvokeCurrent(invokeId, req.params.nodeId, client.connId)
  );
}

/** One Gateway's preparation leases; handler execution belongs to its existing runtime owner. */
export class GatewayRequestEntryLifetime {
  private readonly stopping = new AbortController();
  private readonly active = new Set<Promise<void>>();
  private sealed = false;
  readonly signal = this.stopping.signal;

  enter(options: RequestEntryOptions): GatewayRequestEntry {
    let released = false;
    const assertOpen = () => {
      // Shutdown may still issue node cleanup commands. Only their exact pending
      // invoke can enter until transports close; pairing and settlement still revalidate.
      if (released || this.sealed || (this.signal.aborted && !isPendingNodeCompletion(options))) {
        throw new Error("Gateway request entry is closed");
      }
    };
    assertOpen();
    const settled = createDeferredCore();
    this.active.add(settled.promise);
    return {
      assertOpen,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.active.delete(settled.promise);
        settled.resolve();
      },
    };
  }

  beginClose(): void {
    this.stopping.abort();
  }

  async waitForPendingEntries(): Promise<void> {
    await Promise.all(this.active);
  }

  async sealAndJoin(): Promise<void> {
    this.sealed = true;
    await this.waitForPendingEntries();
  }
}
