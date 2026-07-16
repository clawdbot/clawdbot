import type { GatewayClientRequestOptions } from "../gateway/client.js";
import type { NodeHostClient } from "./client.js";
import type { NodeInvokeRequestPayload } from "./invoke.js";

type NodeHostWorkerGatewayResponse =
  | { type: "gateway-response"; id: string; ok: true; result: unknown }
  | { type: "gateway-response"; id: string; ok: false; error: string };

type NodeHostWorkerInput =
  | { type: "invoke"; request: NodeInvokeRequestPayload }
  | { type: "invoke-input"; invokeId: string; seq: number; payloadJSON: string }
  | { type: "invoke-cancel"; invokeId: string }
  | NodeHostWorkerGatewayResponse
  | { type: "stop" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseNodeHostWorkerInput(line: string): NodeHostWorkerInput | null {
  try {
    const parsed = asRecord(JSON.parse(line));
    const type = typeof parsed?.type === "string" ? parsed.type : "";
    if (type === "invoke") {
      const request = asRecord(parsed?.request);
      if (
        request &&
        typeof request.id === "string" &&
        typeof request.nodeId === "string" &&
        typeof request.command === "string"
      ) {
        return { type, request: request as NodeInvokeRequestPayload };
      }
      return null;
    }
    if (type === "gateway-response") {
      const id = typeof parsed?.id === "string" ? parsed.id : "";
      if (!id) {
        return null;
      }
      return parsed?.ok === true
        ? { type, id, ok: true, result: parsed.result }
        : {
            type,
            id,
            ok: false,
            error: typeof parsed?.error === "string" ? parsed.error : "Gateway request failed",
          };
    }
    if (type === "invoke-input") {
      const invokeId = typeof parsed?.invokeId === "string" ? parsed.invokeId : "";
      const seq = typeof parsed?.seq === "number" ? parsed.seq : -1;
      const payloadJSON = typeof parsed?.payloadJSON === "string" ? parsed.payloadJSON : null;
      return invokeId && Number.isInteger(seq) && seq >= 0 && payloadJSON !== null
        ? { type, invokeId, seq, payloadJSON }
        : null;
    }
    if (type === "invoke-cancel") {
      const invokeId = typeof parsed?.invokeId === "string" ? parsed.invokeId : "";
      return invokeId ? { type, invokeId } : null;
    }
    return type === "stop" ? { type } : null;
  } catch {
    return null;
  }
}

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
