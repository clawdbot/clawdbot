import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import WebSocket, { type RawData } from "ws";
import type { CodexAppServerStartOptions } from "./config.js";
import type { CodexAppServerTransport } from "./transport.js";

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
  const socket = new WebSocket(options.url, { headers });
  const pendingFrames: string[] = [];
  let killed = false;

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
  });
  socket.once("error", (error) => events.emit("error", error));
  socket.once("close", (code, reason) => {
    killed = true;
    events.emit("exit", code, reason.toString("utf8"));
  });
  socket.on("message", (data) => {
    const text = websocketFrameToText(data);
    stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  });

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const frame of chunk.toString("utf8").split("\n")) {
        sendFrame(frame);
      }
      callback();
    },
  });

  return {
    stdin,
    stdout,
    stderr,
    get killed() {
      return killed;
    },
    kill: () => {
      killed = true;
      socket.close();
    },
    once: (event, listener) => events.once(event, listener),
  };
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
