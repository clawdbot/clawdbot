import type { GatewayClientRequestOptions } from "../gateway/client.js";
import type { NodeHostClient } from "./client.js";

export type NodeHostWorkerGatewayResponse =
  | { type: "gateway-response"; id: string; ok: true; result: unknown }
  | { type: "gateway-response"; id: string; ok: false; error: string };

type PendingGatewayRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class NodeHostWorkerBridgeClient implements NodeHostClient {
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingGatewayRequest>();

  constructor(private readonly writeMessage: (message: unknown) => void) {}

  async request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: GatewayClientRequestOptions,
  ): Promise<T> {
    if (method === "node.invoke.result") {
      this.writeMessage({ type: "invoke-result", result: params ?? {} });
      return {} as T;
    }
    if (method === "node.event") {
      this.writeMessage({ type: "node-event", event: params ?? {} });
      return {} as T;
    }

    const id = `gateway-${this.nextRequestId++}`;
    const timeoutMs = Math.max(1, opts?.timeoutMs ?? 15_000);
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.writeMessage({ type: "gateway-request", id, method, params: params ?? {}, timeoutMs });
    return (await response) as T;
  }

  handleResponse(message: NodeHostWorkerGatewayResponse): boolean {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return false;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error));
    }
    return true;
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("node-host worker stopped"));
    }
    this.pending.clear();
  }
}

export async function stopNodeHostWorkerFromSignal(
  input: { close(): void },
  stop: (exitCode: number) => Promise<void>,
  exitCode: number,
): Promise<void> {
  const stopped = stop(exitCode);
  input.close();
  await stopped;
}
