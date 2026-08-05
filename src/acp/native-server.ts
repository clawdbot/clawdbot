#!/usr/bin/env node
/** Self-contained ACP stdio server backed by the process-local OpenClaw runtime. */
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  type Agent,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import { routeLogsToStderr } from "../logging/console.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { AcpNativeAgent } from "./native-agent.js";
import { normalizeAcpInitializeProtocolVersion } from "./protocol-version.js";

type NativeRuntimeAgent = Agent & {
  start?: () => void;
  shutdown: (reason?: unknown) => Promise<void>;
};

type NativeServerDependencies = {
  input?: ReadableStream<Uint8Array>;
  output?: WritableStream<Uint8Array>;
  createAgent?: (connection: AgentSideConnection) => NativeRuntimeAgent;
  closeStateDatabase?: () => void;
  installSignalHandlers?: boolean;
};

/** Starts the self-contained OpenClaw ACP agent over stdio. */
export async function serveAcpNative(deps: NativeServerDependencies = {}): Promise<void> {
  routeLogsToStderr();
  const input =
    deps.input ?? (Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>);
  const output = deps.output ?? Writable.toWeb(process.stdout);
  const stream = ndJsonStream(output, input);
  const readable = stream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        controller.enqueue(normalizeAcpInitializeProtocolVersion(message));
      },
    }),
  );

  let agent: NativeRuntimeAgent | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const closeStateDatabase = deps.closeStateDatabase ?? closeOpenClawStateDatabase;
  const shutdown = (reason?: unknown) => {
    shutdownPromise ??= (async () => {
      await agent?.shutdown(reason);
      closeStateDatabase();
    })();
    return shutdownPromise;
  };

  const connection = new AgentSideConnection(
    (conn) => {
      agent = deps.createAgent?.(conn) ?? new AcpNativeAgent(conn);
      agent.start?.();
      return agent;
    },
    { ...stream, readable },
  );
  const onSignal = () => {
    process.stdin.destroy();
    void shutdown(new Error("ACP process shutting down"));
  };
  const installSignalHandlers = deps.installSignalHandlers !== false;
  if (installSignalHandlers) {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  }
  try {
    await connection.closed;
  } finally {
    if (installSignalHandlers) {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
    await shutdown(connection.signal.reason);
  }
}
