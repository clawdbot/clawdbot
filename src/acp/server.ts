#!/usr/bin/env node
/**
 * ACP-GW Server Entry Point
 *
 * Gateway-backed ACP server. Speaks stdio JSON-RPC to IDE clients,
 * delegates all agent work to a running Clawdis Gateway via WebSocket.
 *
 * Usage:
 *   clawd-acp [--gateway-url <url>] [--gateway-token <token>] [--verbose]
 */

import { Readable, Writable } from "node:stream";

import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import { GatewayClient } from "../gateway/client.js";
import { initSessionStore } from "./session.js";
import { AcpGwAgent } from "./translator.js";
import type { AcpGwOptions } from "./types.js";

const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const DEFAULT_SESSION_STORE = "~/.clawdis/acp-sessions.json";
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Start the ACP-GW server.
 */
export function serveAcpGw(opts: AcpGwOptions = {}): void {
  const log = opts.verbose
    ? (msg: string) => process.stderr.write(`[acp] ${msg}\n`)
    : () => {};

  // Initialize session persistence
  function resolveStorePath(p: string): string {
    if (p.startsWith("~")) {
      return p.replace("~", process.env.HOME ?? "");
    }
    return p;
  }

  // Empty string means disabled, undefined means use default
  const storePath = opts.sessionStorePath === ""
    ? null
    : resolveStorePath(opts.sessionStorePath ?? DEFAULT_SESSION_STORE);
  if (storePath) {
    initSessionStore(storePath);
    log(`session store: ${storePath}`);
  } else {
    log("session persistence disabled");
  }

  const gatewayUrl = opts.gatewayUrl ?? DEFAULT_GATEWAY_URL;
  log(`connecting to gateway: ${gatewayUrl}`);

  let agent: AcpGwAgent | null = null;
  let gateway: GatewayClient | null = null;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const createGatewayClient = (): GatewayClient => {
    return new GatewayClient({
      url: gatewayUrl,
      token: opts.gatewayToken,
      password: opts.gatewayPassword,
      clientName: "acp",
      clientVersion: "1.0.0",
      mode: "acp",
      onHelloOk: (hello) => {
        log(`gateway connected: protocol=${hello.protocol}`);
        reconnectAttempts = 0; // Reset on successful connection
        if (agent) {
          agent.handleGatewayReconnect();
        }
      },
      onClose: (code, reason) => {
        log(`gateway disconnected: ${code} ${reason}`);
        agent?.handleGatewayDisconnect(`${code}: ${reason}`);
        
        // Attempt reconnection for non-fatal closes
        if (code !== 1000 && code !== 1001) {
          scheduleReconnect();
        }
      },
      onEvent: (evt) => {
        void agent?.handleGatewayEvent(evt);
      },
    });
  };

  const scheduleReconnect = (): void => {
    if (reconnectTimer) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log(`max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
      return;
    }

    reconnectAttempts++;
    const delay = RECONNECT_DELAY_MS * reconnectAttempts;
    log(`scheduling reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      log(`attempting reconnect...`);
      gateway = createGatewayClient();
      if (agent) {
        agent.updateGateway(gateway);
      }
      gateway.start();
    }, delay);
  };

  // Create initial Gateway client
  gateway = createGatewayClient();

  // Create Web Streams from Node streams for the ACP SDK
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  // Create the ACP connection
  new AgentSideConnection((conn) => {
    agent = new AcpGwAgent(conn, gateway!, opts);
    agent.start();
    return agent;
  }, stream);

  // Start the Gateway client
  gateway.start();

  log("acp server ready");
}

/**
 * Parse CLI arguments.
 */
function parseArgs(args: string[]): AcpGwOptions {
  const opts: AcpGwOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "--gateway-url" || arg === "--url") && args[i + 1]) {
      opts.gatewayUrl = args[++i];
    } else if ((arg === "--gateway-token" || arg === "--token") && args[i + 1]) {
      opts.gatewayToken = args[++i];
    } else if (
      (arg === "--gateway-password" || arg === "--password") &&
      args[i + 1]
    ) {
      opts.gatewayPassword = args[++i];
    } else if (arg === "--verbose" || arg === "-v") {
      opts.verbose = true;
    } else if (arg === "--session-store" && args[i + 1]) {
      opts.sessionStorePath = args[++i];
    } else if (arg === "--no-session-store") {
      opts.sessionStorePath = "";
    } else if (arg === "--cwd" && args[i + 1]) {
      // Ignored for compatibility (cwd comes from session/new)
      i++;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: clawd-acp [options]

Gateway-backed ACP server for IDE integration.

Options:
  --gateway-url <url>      Gateway WebSocket URL (default: ws://127.0.0.1:18789)
  --gateway-token <token>  Gateway auth token
  --gateway-password <pw>  Gateway auth password
  --session-store <path>   Session persistence file (default: ~/.clawdis/acp-sessions.json)
  --no-session-store       Disable session persistence
  --verbose, -v            Enable verbose logging to stderr
  --help, -h               Show this help message

Examples:
  clawd-acp
  clawd-acp --gateway-url wss://remote:18789 --gateway-token secret
  clawd-acp --verbose
  clawd-acp --no-session-store
`);
      process.exit(0);
    }
  }

  return opts;
}

/**
 * CLI entry point.
 */
function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  serveAcpGw(opts);
}

// Run if executed directly
main();
