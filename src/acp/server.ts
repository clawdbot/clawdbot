#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { getRuntimeConfig } from "../config/config.js";
import { resolveGatewayClientBootstrap } from "../gateway/client-bootstrap.js";
import { GatewayClient } from "../gateway/client.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import { isMainModule } from "../infra/is-main.js";
import { routeLogsToStderr } from "../logging/console.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { readSecretFromFile } from "./secret-file.js";
import { AcpGatewayAgent } from "./translator.js";
import { normalizeAcpProvenanceMode, type AcpServerOptions } from "./types.js";

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
  let stopped = false;
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

  const gateway = new GatewayClient({
    url: bootstrap.url,
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "ACP",
    clientVersion: "acp",
    mode: GATEWAY_CLIENT_MODES.CLI,
    onEvent: (evt) => {
      void agent?.handleGatewayEvent(evt);
    },
    onHelloOk: () => {
      resolveGatewayReady();
      agent?.handleGatewayReconnect();
    },
    onConnectError: (err) => {
      rejectGatewayReady(err);
    },
    onClose: (code, reason) => {
      if (!stopped) {
        rejectGatewayReady(new Error(`gateway closed before ready (${code}): ${reason}`));
      }
      agent?.handleGatewayDisconnect(`${code}: ${reason}`);
      // Resolve only on intentional shutdown (gateway.stop() sets closed
      // which skips scheduleReconnect, then fires onClose).  Transient
      // disconnects are followed by automatic reconnect attempts.
      if (stopped) {
        onClosed();
      }
    },
  });

  const shutdown = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    resolveGatewayReady();
    gateway.stop();
    // If no WebSocket is active (e.g. between reconnect attempts),
    // gateway.stop() won't trigger onClose, so resolve directly.
    onClosed();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Start gateway first and wait for hello before accepting ACP requests.
  gateway.start();
  await gatewayReady.catch((err) => {
    shutdown();
    throw err;
  });
  if (stopped) {
    return closed;
  }

  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  const _connection = new AgentSideConnection((conn: AgentSideConnection) => {
    agent = new AcpGatewayAgent(conn, gateway, opts);
    agent.start();
    return agent;
  }, stream);

  return closed;
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
  serveAcpGateway(opts).catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
}
