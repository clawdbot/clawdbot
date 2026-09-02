/** Private JSONL worker exposing the CLI node-host runtime to the macOS app. */
import { createInterface } from "node:readline";
import { requestExitAfterOneShotOutput } from "../cli/one-shot-exit.js";
import { VERSION } from "../version.js";
import type { NodeHostClient } from "./client.js";
import { loadNodeHostConfig } from "./config.js";
import { startNodeHostConnection } from "./connection.js";
import { prepareNodeHostRuntime } from "./runtime.js";
import { runStartupMigrations } from "./startup-state-migrations.js";
import {
  NodeHostWorkerBridgeClient,
  parseNodeHostWorkerInput,
  stopNodeHostWorkerFromSignal,
} from "./worker-support.js";

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeStderrLine(message: string): void {
  process.stderr.write(`${message}\n`);
}

export async function runNodeHostWorker(): Promise<void> {
  // Operator-approved startup is a second authorized entry point for Doctor-owned
  // state migrators. Runtime invokes those owners here and never migrates inline.
  await runStartupMigrations({ log: { info: writeStderrLine, warn: writeStderrLine } });
  const nodeConfig = await loadNodeHostConfig();
  // The private app worker is a capability superset; persisted headless
  // command allowlists never apply here.
  const prepared = await prepareNodeHostRuntime({
    enableDuplexPluginCommands: true,
    enableWorkerRuns: true,
    installedAppsSharingEnabled: nodeConfig?.installedAppsSharing === true,
  });
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

  let generation = 0;
  let connected = false;
  let readySent = false;
  let currentManifest = prepared.manifest;
  const runtime = startNodeHostConnection({
    prepared,
    client,
    writeStderrLine,
    onManifestChanged: (manifest) => {
      currentManifest = manifest;
      if (readySent) {
        connected = false;
        client.setConnection(generation, false);
        runtime.disconnect();
        writeMessage({ type: "manifest", version: VERSION, manifest });
      }
    },
  });
  writeMessage({
    type: "ready",
    version: VERSION,
    manifest: currentManifest,
  });

  readySent = true;

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    const message = parseNodeHostWorkerInput(line);
    if (!message) {
      writeMessage({ type: "protocol-error", error: "invalid worker request" });
      return;
    }
    if (message.type === "gateway-connection") {
      if (message.generation <= generation) {
        return;
      }
      generation = message.generation;
      connected = message.connection !== null;
      client.setConnection(generation, connected);
      runtime.disconnect();
      if (message.connection) {
        // Publication belongs to this connection, even when a supervisor update
        // originates during cleanup of an invocation from the retired route.
        const connectionGeneration = generation;
        runtime.connect(message.connection, {
          request: <T>(...args: Parameters<NodeHostClient["request"]>) =>
            client.withConnection(connectionGeneration, () => client.request<T>(...args)),
        });
      }
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
    if (!connected || message.generation !== generation) {
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
    void client.withConnection(generation, () => runtime.invoke(message.request));
  });
  input.on("close", () => void stop(0));
  const onInterrupt = () => void stopNodeHostWorkerFromSignal(input, stop, 130);
  const onTerminate = () => void stopNodeHostWorkerFromSignal(input, stop, 143);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    await stopped;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    // runtime.close() drains only runtime-owned owners. A plugin-owned child keeps
    // ref'd pipes past that point and pins the loop, so exit must not wait for a drain.
    requestExitAfterOneShotOutput();
  }
}
