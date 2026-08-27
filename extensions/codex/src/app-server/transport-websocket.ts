/**
 * Adapts a remote Codex app-server WebSocket endpoint to the shared stdio-like
 * transport interface.
 */
import { EventEmitter } from "node:events";
import net from "node:net";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import WebSocket, { type RawData } from "ws";
import { resolveCodexAppServerUserHomeDir, type CodexAppServerStartOptions } from "./config.js";
import type { CodexAppServerTransport } from "./transport.js";

const WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 10_000;
const WEBSOCKET_PING_INTERVAL_MS = 20_000;
const WEBSOCKET_PONG_TIMEOUT_MS = 20_000;
const MAX_CONSECUTIVE_MISSED_WEBSOCKET_PONGS = 5;

/** Opens a WebSocket app-server transport and maps newline-delimited frames to stdout/stdin. */
export function createWebSocketTransport(
  options: CodexAppServerStartOptions,
): CodexAppServerTransport {
  if (!options.url) {
    throw new Error(
      "codex app-server websocket transport requires plugins.entries.codex.config.appServer.url",
    );
  }
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const headers = {
    ...options.headers,
    ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
  };
  const websocketOptions: WebSocket.ClientOptions = {
    headers,
    // Codex app-server closes Unix upgrade handshakes that offer compression.
    perMessageDeflate: false,
    ...(options.transport === "websocket"
      ? { handshakeTimeout: WEBSOCKET_HANDSHAKE_TIMEOUT_MS }
      : {}),
  };
  const unixSocketPath = resolveCodexAppServerUnixSocketPath(options);
  const socket = unixSocketPath
    ? new WebSocket("ws://localhost/", {
        ...websocketOptions,
        createConnection: () => connectCodexAppServerUnixSocket(unixSocketPath),
      })
    : new WebSocket(options.url, websocketOptions);
  const pendingFrames: string[] = [];
  const stdinDecoder = new StringDecoder("utf8");
  let pendingLine = "";
  let killed = false;
  let pingTimeout: NodeJS.Timeout | undefined;
  let pongTimeout: NodeJS.Timeout | undefined;
  let expectedPong: Buffer | undefined;
  let consecutiveMissedPongs = 0;
  let heartbeatSequence = 0;

  const clearConnectionHealthTimers = () => {
    if (pingTimeout) {
      clearTimeout(pingTimeout);
      pingTimeout = undefined;
    }
    if (pongTimeout) {
      clearTimeout(pongTimeout);
      pongTimeout = undefined;
    }
    expectedPong = undefined;
  };

  const sendHeartbeatPing = () => {
    if (socket.readyState !== WebSocket.OPEN || pongTimeout) {
      return;
    }

    const payload = Buffer.from(`openclaw-codex-${++heartbeatSequence}`);
    expectedPong = payload;
    pongTimeout = setTimeout(() => {
      pongTimeout = undefined;
      expectedPong = undefined;
      consecutiveMissedPongs += 1;
      if (consecutiveMissedPongs >= MAX_CONSECUTIVE_MISSED_WEBSOCKET_PONGS) {
        socket.terminate();
        return;
      }
      sendHeartbeatPing();
    }, WEBSOCKET_PONG_TIMEOUT_MS);
    pongTimeout.unref();
    socket.ping(payload, undefined, (error) => {
      if (error) {
        socket.terminate();
      }
    });
  };

  const scheduleHeartbeatPing = () => {
    if (
      options.transport !== "websocket" ||
      socket.readyState !== WebSocket.OPEN ||
      pingTimeout ||
      pongTimeout
    ) {
      return;
    }
    pingTimeout = setTimeout(() => {
      pingTimeout = undefined;
      sendHeartbeatPing();
    }, WEBSOCKET_PING_INTERVAL_MS);
    pingTimeout.unref();
  };

  const recordConnectionActivity = () => {
    consecutiveMissedPongs = 0;
    if (pongTimeout) {
      clearTimeout(pongTimeout);
      pongTimeout = undefined;
    }
    expectedPong = undefined;
    scheduleHeartbeatPing();
  };

  const sendFrame = (frame: string) => {
    const trimmed = frame.trim();
    if (!trimmed) {
      return;
    }
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(trimmed);
      return;
    }
    pendingFrames.push(trimmed);
  };

  // `initialize` can be written before the WebSocket open event fires. Buffer
  // whole JSON-RPC frames so stdio and websocket transports share call timing.
  socket.once("open", () => {
    for (const frame of pendingFrames.splice(0)) {
      socket.send(frame);
    }
    scheduleHeartbeatPing();
  });
  socket.on("pong", (payload) => {
    if (expectedPong?.equals(payload)) {
      recordConnectionActivity();
    }
  });
  socket.once("error", (error) => {
    clearConnectionHealthTimers();
    events.emit("error", error);
  });
  socket.once("close", (code, reason) => {
    clearConnectionHealthTimers();
    killed = true;
    events.emit("exit", code, reason.toString("utf8"));
  });
  socket.on("message", (data) => {
    if (options.transport === "websocket") {
      recordConnectionActivity();
    }
    const text = websocketFrameToText(data);
    stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  });

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      pendingLine += stdinDecoder.write(chunk);
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";
      for (const frame of lines) {
        sendFrame(frame);
      }
      callback();
    },
    final(callback) {
      pendingLine += stdinDecoder.end();
      if (pendingLine) {
        sendFrame(pendingLine);
      }
      pendingLine = "";
      callback();
    },
  });
  const closeSocket = () => {
    if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      return;
    }
    socket.close();
  };
  stdin.once("finish", closeSocket);
  stdin.once("close", closeSocket);

  return {
    stdin,
    stdout,
    stderr,
    get killed() {
      return killed;
    },
    kill: () => {
      killed = true;
      clearConnectionHealthTimers();
      socket.close();
    },
    once: (event, listener) => events.once(event, listener),
  };
}

/** Opens the owner-scoped Codex control socket used by the WebSocket upgrade. */
function connectCodexAppServerUnixSocket(socketPath: string): net.Socket {
  return net.createConnection(socketPath);
}

/** Resolves the canonical or explicitly configured Codex control socket. */
function resolveCodexAppServerUnixSocketPath(
  options: Pick<CodexAppServerStartOptions, "env" | "transport" | "url">,
): string | undefined {
  if (options.transport !== "unix") {
    if (options.url?.startsWith("unix://")) {
      throw new Error("codex app-server unix URL requires unix transport");
    }
    return undefined;
  }
  const url = options.url ?? "unix://";
  if (!url.startsWith("unix://")) {
    throw new Error("codex app-server unix transport requires a unix:// URL");
  }
  const configuredPath = url.slice("unix://".length);
  return (
    configuredPath ||
    path.join(
      resolveCodexAppServerUserHomeDir(options.env ?? process.env),
      "app-server-control",
      "app-server-control.sock",
    )
  );
}

function websocketFrameToText(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}
