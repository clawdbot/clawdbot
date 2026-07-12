/** Private JSONL worker exposing the CLI node-host runtime to the macOS app. */
import { createInterface } from "node:readline";
import { VERSION } from "../version.js";
import type { NodeInvokeRequestPayload } from "./invoke.js";
import { prepareNodeHostRuntime, type NodeHostInventory } from "./runtime.js";
import {
  NodeHostWorkerBridgeClient,
  type NodeHostWorkerGatewayResponse,
  stopNodeHostWorkerFromSignal,
} from "./worker-support.js";

type WorkerInput =
  | { type: "invoke"; request: NodeInvokeRequestPayload }
  | NodeHostWorkerGatewayResponse
  | { type: "stop" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function parseInput(line: string): WorkerInput | null {
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
    return type === "stop" ? { type } : null;
  } catch {
    return null;
  }
}

function emitInventory(inventory: NodeHostInventory): void {
  writeMessage({ type: "inventory", inventory });
}

export async function runNodeHostWorker(): Promise<void> {
  const prepared = await prepareNodeHostRuntime();
  const client = new NodeHostWorkerBridgeClient(writeMessage);
  let stopping = false;
  let resolveStopped: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const stop = async (exitCode: number) => {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      client.close();
      await runtime.close();
      process.exitCode = exitCode;
    } finally {
      resolveStopped?.();
    }
  };

  const runtime = prepared.start({ client, onInventoryChanged: emitInventory });
  writeMessage({
    type: "ready",
    version: VERSION,
    manifest: prepared.manifest,
    inventory: prepared.initialInventory,
  });

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    const message = parseInput(line);
    if (!message) {
      writeMessage({ type: "protocol-error", error: "invalid worker request" });
      return;
    }
    if (message.type === "gateway-response") {
      client.handleResponse(message);
      return;
    }
    if (message.type === "stop") {
      input.close();
      void stop(0);
      return;
    }
    void runtime.invoke(message.request);
  });
  input.on("close", () => void stop(0));
  process.once("SIGINT", () => void stopNodeHostWorkerFromSignal(input, stop, 130));
  process.once("SIGTERM", () => void stopNodeHostWorkerFromSignal(input, stop, 143));
  await stopped;
}
