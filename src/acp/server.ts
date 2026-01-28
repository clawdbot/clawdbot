#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import { loadConfig } from "../config/config.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { GatewayClient } from "../gateway/client.js";
import { isMainModule } from "../infra/is-main.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { AcpGatewayAgent } from "./translator.js";
import type { AcpServerOptions } from "./types.js";

export function serveAcpGateway(opts: AcpServerOptions = {}): void {
  const cfg = loadConfig();
  const connection = buildGatewayConnectionDetails({
    config: cfg,
    url: opts.gatewayUrl,
  });

  const isRemoteMode = cfg.gateway?.mode === "remote";
  const remote = isRemoteMode ? cfg.gateway?.remote : undefined;
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, env: process.env });

  const token =
    opts.gatewayToken ??
    (isRemoteMode ? remote?.token?.trim() : undefined) ??
    process.env.CLAWDBOT_GATEWAY_TOKEN ??
    auth.token;
  const password =
    opts.gatewayPassword ??
    (isRemoteMode ? remote?.password?.trim() : undefined) ??
    process.env.CLAWDBOT_GATEWAY_PASSWORD ??
    auth.password;

  let agent: AcpGatewayAgent | null = null;
  const gateway = new GatewayClient({
    url: connection.url,
    token: token || undefined,
    password: password || undefined,
    clientName: GATEWAY_CLIENT_NAMES.CLI,
    clientDisplayName: "ACP",
    clientVersion: "acp",
    mode: GATEWAY_CLIENT_MODES.CLI,
    onEvent: (evt) => {
      void agent?.handleGatewayEvent(evt);
    },
    onHelloOk: () => {
      agent?.handleGatewayReconnect();
    },
    onClose: (code, reason) => {
      agent?.handleGatewayDisconnect(`${code}: ${reason}`);
    },
  });

  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  new AgentSideConnection((conn: AgentSideConnection) => {
    agent = new AcpGatewayAgent(conn, gateway, opts);
    agent.start();
    return agent;
  }, stream);

  gateway.start();
}

function parseArgs(args: string[]): AcpServerOptions {
  const opts: AcpServerOptions = {};
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
    if (arg === "--password" || arg === "--gateway-password") {
      opts.gatewayPassword = args[i + 1];
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
    if (arg === "--verbose" || arg === "-v") {
      opts.verbose = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`Usage: moltbot acp [options]

Gateway-backed ACP server for IDE integration.

Options:
  --url <url>             Gateway WebSocket URL
  --token <token>         Gateway auth token
  --password <password>   Gateway auth password
  --session <key>         Default session key (e.g. "agent:main:main")
  --session-label <label> Default session label to resolve
  --require-existing      Fail if the session key/label does not exist
  --reset-session         Reset the session key before first use
  --no-prefix-cwd         Do not prefix prompts with the working directory
  --verbose, -v           Verbose logging to stderr
  --help, -h              Show this help message
`);
}

if (isMainModule({ currentFile: fileURLToPath(import.meta.url) })) {
  const opts = parseArgs(process.argv.slice(2));
  serveAcpGateway(opts);
}
