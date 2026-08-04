#!/usr/bin/env node
/** ACP stdio server that bridges Agent Client Protocol clients to the OpenClaw Gateway. */
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  AGENT_METHODS,
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type AnyMessage,
} from "@agentclientprotocol/sdk";
import type { AcpServerOptions } from "@openclaw/acp-core/types";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";
import { startGatewayClientWhenEventLoopReady } from "../gateway/client-start-readiness.js";
import { GatewayClient } from "../gateway/client.js";
import { isMainModule } from "../infra/is-main.js";
import { routeLogsToStderr } from "../logging/console.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createSqliteAcpEventLedger } from "./event-ledger.js";
import { readSecretFromFile } from "./secret-file.js";
import { AcpGatewayAgent } from "./translator.js";
import { normalizeAcpProvenanceMode } from "./types.js";

type JsonObject = Record<string, unknown>;

const MAX_STARTUP_ACP_BUFFER_BYTES = 1024 * 1024;

function createStartupInputMonitor(input: ReadableStream<Uint8Array>): {
  dispose: () => void;
  ended: Promise<void>;
  takeReadable: () => ReadableStream<Uint8Array>;
} {
  const [monitor, readable] = input.tee();
  const reader = monitor.getReader();
  let readableTaken = false;
  let monitorCancelled = false;
  const cancelMonitor = (reason?: unknown) => {
    if (monitorCancelled) {
      return;
    }
    monitorCancelled = true;
    void reader.cancel(reason).catch(() => {});
  };
  const cancelBoth = (reason?: unknown) => {
    cancelMonitor(reason);
    void readable.cancel(reason).catch(() => {});
  };
  const ended = (async () => {
    try {
      let bufferedBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        // Drain raw stdin so EOF remains observable before Gateway hello. The
        // other branch retains the same bytes for the eventual SDK reader.
        bufferedBytes += value.byteLength;
        if (bufferedBytes > MAX_STARTUP_ACP_BUFFER_BYTES) {
          const error = new Error("ACP startup input exceeded the 1 MiB buffer limit");
          cancelBoth(error);
          throw error;
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    dispose: () => {
      if (!readableTaken) {
        cancelBoth();
      } else {
        cancelMonitor();
      }
    },
    ended,
    takeReadable: () => {
      readableTaken = true;
      return readable;
    },
  };
}

/** Starts the ACP Gateway bridge and serves AgentSideConnection over stdio. */
export async function serveAcpGateway(opts: AcpServerOptions = {}): Promise<void> {
  routeLogsToStderr();
  const cfg = getRuntimeConfig();
  const bootstrap = await resolveGatewayClientBootstrap({
    config: cfg,
    gatewayUrl: opts.gatewayUrl,
    explicitAuth: {
      token: opts.gatewayToken,
      password: opts.gatewayPassword,
    },
    env: process.env,
  });

  let agent: AcpGatewayAgent | null = null;
  let onClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    onClosed = resolve;
  });
  const startupAbortController = new AbortController();
  let stopped = false;
  let gatewayConnected = false;
  let onGatewayReadyResolve!: () => void;
  let onGatewayReadyReject!: (err: Error) => void;
  let gatewayReadySettled = false;
  const gatewayReady = new Promise<void>((resolve, reject) => {
    onGatewayReadyResolve = resolve;
    onGatewayReadyReject = reject;
  });
  const resolveGatewayReady = () => {
    if (gatewayReadySettled) {
      return;
    }
    gatewayReadySettled = true;
    onGatewayReadyResolve();
  };
  const rejectGatewayReady = (err: unknown) => {
    if (gatewayReadySettled) {
      return;
    }
    gatewayReadySettled = true;
    onGatewayReadyReject(err instanceof Error ? err : new Error(String(err)));
  };
  const closeStateDatabase = () => {
    try {
      closeOpenClawStateDatabase();
    } catch (err) {
      console.warn(`acp: state database close failed during shutdown: ${String(err)}`);
    }
  };

  const gateway = new GatewayClient({
    url: bootstrap.url,
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "ACP",
    clientVersion: "acp",
    mode: GATEWAY_CLIENT_MODES.CLI,
    caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS, GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
    onEvent: (evt) => {
      if (stopped) {
        return;
      }
      // Gateway delivery stays non-blocking, but translator failures must not
      // escape this callback as unhandled process rejections.
      void agent?.handleGatewayEvent(evt).catch((err: unknown) => {
        process.stderr.write(`openclaw acp: gateway event ${evt.event} failed\n`);
        if (opts.verbose) {
          process.stderr.write(`openclaw acp: gateway event ${evt.event} error: ${String(err)}\n`);
        }
      });
    },
    onHelloOk: () => {
      gatewayConnected = true;
      resolveGatewayReady();
      agent?.handleGatewayReconnect();
    },
    onConnectError: (err) => {
      rejectGatewayReady(err);
    },
    onClose: (code, reason) => {
      if (stopped) {
        return;
      }
      rejectGatewayReady(new Error(`gateway closed before ready (${code}): ${reason}`));
      agent?.handleGatewayDisconnect(`${code}: ${reason}`);
    },
  });
  // Construct the sole stdin reader before waiting for Gateway hello. The raw
  // monitor branch actively detects EOF while the bounded replay branch retains
  // every byte until the SDK is ready to consume it.
  const rawInput = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const startupInput = createStartupInputMonitor(rawInput);

  const shutdown = async () => {
    if (stopped) {
      return;
    }
    stopped = true;
    startupAbortController.abort();
    startupInput.dispose();
    process.stdin.pause();
    resolveGatewayReady();
    // Revoke ledger access before transport teardown. ACP requests and Gateway
    // events can both resume asynchronously, and must not reopen the shared DB.
    const activeAgent = agent;
    agent = null;
    activeAgent?.shutdown();
    const gatewayStop = gateway.stopAndWait().catch((err: unknown) => {
      console.warn(`acp: gateway stop failed during shutdown: ${String(err)}`);
    });
    await gatewayStop;
    closeStateDatabase();
    onClosed();
  };

  void startupInput.ended.then(() => {
    if (!gatewayConnected) {
      void shutdown();
    }
  }, shutdown);

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });

  // Wait for Gateway hello before dispatching buffered ACP requests.
  const readiness = await startGatewayClientWhenEventLoopReady(gateway, {
    clientOptions: { preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs },
    signal: startupAbortController.signal,
  });
  if (!readiness.ready) {
    rejectGatewayReady(new Error("gateway event loop readiness timeout"));
  }
  await gatewayReady.catch(async (err: unknown) => {
    await shutdown();
    throw err;
  });
  if (stopped) {
    return closed;
  }

  const bufferedInput = startupInput.takeReadable();
  startupInput.dispose();
  const output = Writable.toWeb(process.stdout);
  const stream = ndJsonStream(output, bufferedInput);
  const readable = stream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        controller.enqueue(normalizeAcpInitializeProtocolVersion(message));
      },
    }),
  );
  const eventLedger = createSqliteAcpEventLedger();

  const connection = new AgentSideConnection(
    (conn: AgentSideConnection) => {
      agent = new AcpGatewayAgent(conn, gateway, { ...opts, eventLedger });
      agent.start();
      return agent;
    },
    { ...stream, readable },
  );
  // The SDK closes the connection when stdin reaches EOF. Reuse the normal
  // shutdown path so the Gateway and shared database cannot keep the bridge alive.
  void connection.closed.then(shutdown, shutdown);

  return closed;
}

function normalizeAcpInitializeProtocolVersion(message: AnyMessage): AnyMessage {
  if (!isJsonObject(message)) {
    return message;
  }
  const messageObject: JsonObject = message;
  if (messageObject.method !== AGENT_METHODS.initialize) {
    return message;
  }
  const params = messageObject.params;
  if (!isJsonObject(params) || isUint16Integer(params.protocolVersion)) {
    return message;
  }

  // ACP SDK 0.22 validates this uint16 before the agent handler runs; some
  // editors send MCP date strings here, so normalize only this handshake field.
  return {
    ...message,
    params: {
      ...params,
      protocolVersion: PROTOCOL_VERSION,
    },
  } as AnyMessage;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUint16Integer(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff;
}

function parseArgs(args: string[]): AcpServerOptions {
  const opts: AcpServerOptions = {};
  let tokenFile: string | undefined;
  let passwordFile: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--url" || arg === "--gateway-url") {
      opts.gatewayUrl = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--token" || arg === "--gateway-token") {
      opts.gatewayToken = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--token-file" || arg === "--gateway-token-file") {
      tokenFile = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--password" || arg === "--gateway-password") {
      opts.gatewayPassword = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--password-file" || arg === "--gateway-password-file") {
      passwordFile = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--session") {
      opts.defaultSessionKey = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--session-label") {
      opts.defaultSessionLabel = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--require-existing") {
      opts.requireExistingSession = true;
      continue;
    }
    if (arg === "--reset-session") {
      opts.resetSession = true;
      continue;
    }
    if (arg === "--no-prefix-cwd") {
      opts.prefixCwd = false;
      continue;
    }
    if (arg === "--provenance") {
      const provenanceMode = normalizeAcpProvenanceMode(args[i + 1]);
      if (!provenanceMode) {
        throw new Error("Invalid --provenance value. Use off, meta, or meta+receipt.");
      }
      opts.provenanceMode = provenanceMode;
      i += 1;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      opts.verbose = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  const gatewayToken = normalizeOptionalString(opts.gatewayToken);
  const gatewayPassword = normalizeOptionalString(opts.gatewayPassword);
  const normalizedTokenFile = normalizeOptionalString(tokenFile);
  const normalizedPasswordFile = normalizeOptionalString(passwordFile);
  if (gatewayToken && normalizedTokenFile) {
    throw new Error("Use either --token or --token-file.");
  }
  if (gatewayPassword && normalizedPasswordFile) {
    throw new Error("Use either --password or --password-file.");
  }
  if (normalizedTokenFile) {
    opts.gatewayToken = readSecretFromFile(normalizedTokenFile, "Gateway token");
  }
  if (normalizedPasswordFile) {
    opts.gatewayPassword = readSecretFromFile(normalizedPasswordFile, "Gateway password");
  }
  return opts;
}

function printHelp(): void {
  console.log(`Usage: openclaw acp [options]

Gateway-backed ACP server for IDE integration.

Options:
  --url <url>             Gateway WebSocket URL
  --token <token>         Gateway auth token
  --token-file <path>     Read gateway auth token from file
  --password <password>   Gateway auth password
  --password-file <path>  Read gateway auth password from file
  --session <key>         Default session key (e.g. "agent:main:main")
  --session-label <label> Default session label to resolve
  --require-existing      Fail if the session key/label does not exist
  --reset-session         Reset the session key before first use
  --no-prefix-cwd         Do not prefix prompts with the working directory
  --provenance <mode>     ACP provenance mode: off, meta, or meta+receipt
  --verbose, -v           Verbose logging to stderr
  --help, -h              Show this help message
`);
}

if (isMainModule({ currentFile: fileURLToPath(import.meta.url) })) {
  const argv = process.argv.slice(2);
  if (argv.includes("--token") || argv.includes("--gateway-token")) {
    console.error(
      "Warning: --token can be exposed via process listings. Prefer --token-file or OPENCLAW_GATEWAY_TOKEN.",
    );
  }
  if (argv.includes("--password") || argv.includes("--gateway-password")) {
    console.error(
      "Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.",
    );
  }
  const opts = parseArgs(argv);
  serveAcpGateway(opts).catch((err: unknown) => {
    console.error(String(err));
    process.exit(1);
  });
}
