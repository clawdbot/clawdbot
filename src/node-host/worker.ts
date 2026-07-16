/** Private JSONL worker exposing the CLI node-host runtime to the macOS app. */
import { createInterface } from "node:readline";
import { VERSION } from "../version.js";
import { prepareNodeHostRuntime, type NodeHostInventory } from "./runtime.js";
import {
  NodeHostWorkerBridgeClient,
  parseNodeHostWorkerInput,
  stopNodeHostWorkerFromSignal,
} from "./worker-support.js";

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function emitInventory(inventory: NodeHostInventory): void {
  writeMessage({ type: "inventory", inventory });
}

export async function runNodeHostWorker(): Promise<void> {
  const prepared = await prepareNodeHostRuntime({ enableDuplexPluginCommands: true });
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
    const message = parseNodeHostWorkerInput(line);
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
    if (message.type === "invoke-input") {
      runtime.handleInput(message.invokeId, message.seq, message.payloadJSON);
      return;
    }
    if (message.type === "invoke-cancel") {
      runtime.cancel(message.invokeId);
      return;
    }
    void runtime.invoke(message.request);
  });
  input.on("close", () => void stop(0));
  process.once("SIGINT", () => void stopNodeHostWorkerFromSignal(input, stop, 130));
  process.once("SIGTERM", () => void stopNodeHostWorkerFromSignal(input, stop, 143));
  await stopped;
}
