import { AsyncLocalStorage } from "node:async_hooks";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { GatewayClientRequestError } from "../gateway/client.js";
import type { GatewayClientRequestOptions } from "../gateway/client.js";
import { createPendingRequestRegistry } from "../shared/pending-request-registry.js";
import type { NodeHostClient } from "./client.js";
import type { NodeHostGatewayConnection } from "./connection.js";
import type { NodeInvokeRequestPayload } from "./invoke.js";

type NodeHostWorkerGatewayResponse = { generation: number } & (
  | { type: "gateway-response"; id: string; ok: true; result: unknown }
  | { type: "gateway-response"; id: string; ok: false; error: { code: string; message: string } }
);

type NodeHostWorkerInput =
  | { type: "gateway-connection"; generation: number; connection: NodeHostGatewayConnection | null }
  | { type: "invoke"; generation: number; request: NodeInvokeRequestPayload }
  | { type: "invoke-input"; generation: number; invokeId: string; seq: number; payloadJSON: string }
  | { type: "invoke-cancel"; generation: number; invokeId: string }
  | NodeHostWorkerGatewayResponse
  | { type: "stop" };

const connectionSchema = z.object({
  url: z.url(),
  protocol: z.number().int().positive(),
  capabilities: z.array(z.string()),
  tlsFingerprint: z.string().optional(),
  cloudflareAccess: z.object({ clientId: z.string(), clientSecret: z.string() }).optional(),
});

export function parseNodeHostWorkerInput(line: string): NodeHostWorkerInput | null {
  try {
    const parsed = asRecord(JSON.parse(line));
    const type = typeof parsed?.type === "string" ? parsed.type : "";
    if (type === "stop") {
      return { type };
    }
    const generation = parsed?.generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
      return null;
    }
    if (type === "gateway-connection") {
      const connection =
        parsed?.connection === null ? null : connectionSchema.parse(parsed?.connection);
      return { type, generation, connection };
    }
    if (type === "invoke") {
      const request = asRecord(parsed?.request);
      if (
        request &&
        typeof request.id === "string" &&
        typeof request.nodeId === "string" &&
        typeof request.command === "string"
      ) {
        return { type, generation, request: request as NodeInvokeRequestPayload };
      }
      return null;
    }
    if (type === "gateway-response") {
      const id = typeof parsed?.id === "string" ? parsed.id : "";
      if (!id) {
        return null;
      }
      return parsed?.ok === true
        ? { type, generation, id, ok: true, result: parsed.result }
        : {
            type,
            generation,
            id,
            ok: false,
            error: z.object({ code: z.string(), message: z.string() }).parse(parsed?.error),
          };
    }
    if (type === "invoke-input") {
      const invokeId = typeof parsed?.invokeId === "string" ? parsed.invokeId : "";
      const seq = typeof parsed?.seq === "number" ? parsed.seq : -1;
      const payloadJSON = typeof parsed?.payloadJSON === "string" ? parsed.payloadJSON : null;
      return invokeId && Number.isInteger(seq) && seq >= 0 && payloadJSON !== null
        ? { type, generation, invokeId, seq, payloadJSON }
        : null;
    }
    if (type === "invoke-cancel") {
      const invokeId = typeof parsed?.invokeId === "string" ? parsed.invokeId : "";
      return invokeId ? { type, generation, invokeId } : null;
    }
    return null;
  } catch {
    return null;
  }
}

export class NodeHostWorkerBridgeClient implements NodeHostClient {
  private nextRequestId = 1;
  private generation = 0;
  private connected = false;
  private readonly invocationGeneration = new AsyncLocalStorage<number>();

  setConnection(generation: number, connected: boolean): void {
    this.pending.rejectAll(new Error("node-host Gateway route changed"));
    this.generation = generation;
    this.connected = connected;
  }

  withConnection<T>(generation: number, run: () => T): T {
    return this.invocationGeneration.run(generation, run);
  }
  private readonly pending = createPendingRequestRegistry<string, unknown, undefined>();

  constructor(private readonly writeMessage: (message: unknown) => void) {}

  async request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: GatewayClientRequestOptions,
  ): Promise<T> {
    const generation = this.invocationGeneration.getStore() ?? this.generation;
    if (!this.connected || generation !== this.generation) {
      throw new Error("node-host Gateway route is closed");
    }
    if (method === "node.invoke.result") {
      this.writeMessage({ type: "invoke-result", generation, result: params ?? {} });
      return {} as T;
    }
    if (method === "node.event") {
      this.writeMessage({ type: "node-event", generation, event: params ?? {} });
      return {} as T;
    }

    const id = `gateway-${this.nextRequestId++}`;
    const timeoutMs = resolveTimerTimeoutMs(opts?.timeoutMs, 15_000);
    const pending = this.pending.add(id, {
      value: undefined,
      timeoutMs,
      timeoutError: () => new Error(`Gateway request timed out: ${method}`),
    });
    if (!pending) {
      throw new Error(`Gateway request id collision: ${id}`);
    }
    this.writeMessage({
      type: "gateway-request",
      generation,
      id,
      method,
      params: params ?? {},
      timeoutMs,
    });
    return (await pending.promise) as T;
  }

  handleResponse(message: NodeHostWorkerGatewayResponse): boolean {
    if (message.generation !== this.generation) {
      return false;
    }
    const pending = this.pending.take(message.id);
    if (!pending) {
      return false;
    }
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(
        new GatewayClientRequestError({ code: message.error.code, message: message.error.message }),
      );
    }
    return true;
  }

  close(): void {
    this.connected = false;
    this.pending.rejectAll(new Error("node-host worker stopped"));
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
