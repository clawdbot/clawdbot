import net from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, type ClientOptions, type RawData } from "ws";
import {
  buildCloudflareAccessHeaders,
  type CloudflareAccessCredentials,
} from "../../packages/gateway-client/src/cloudflare-access.js";
import { applyGatewayWebSocketTlsPin } from "../../packages/gateway-client/src/websocket-transport.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const PAUSE_BUFFERED_BYTES = 4 * 1024 * 1024;
const RESUME_CHECK_MS = 25;
const streamLog = createSubsystemLogger("node-host/stream");

type NodeStreamCloseTrigger =
  | "owner-abort"
  | "target-close"
  | "target-error"
  | "websocket-close"
  | "websocket-error"
  | "send-error"
  | "invalid-frame"
  | "splice-unavailable"
  | "startup-error";

type NodeStreamDiagnostics = { trigger?: NodeStreamCloseTrigger };

function websocketDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

function attachWebSocketUrl(params: {
  gatewayUrl: string;
  attachPath: string;
  expectedAttachPath: string;
  streamName: string;
}): string {
  const gateway = new URL(params.gatewayUrl);
  const url = new URL(params.attachPath, gateway);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`${params.streamName} stream gateway URL must use WebSocket transport`);
  }
  if (url.origin !== gateway.origin || url.pathname !== params.expectedAttachPath) {
    throw new Error(`${params.streamName} stream attachPath must stay on the connected gateway`);
  }
  // Auxiliary streams share the enrolled node's reverse-proxy mount point.
  url.pathname = `${gateway.pathname.replace(/\/$/u, "")}${url.pathname}`;
  return url.toString();
}

function websocketOptions(
  tlsFingerprint?: string,
  cloudflareAccess?: CloudflareAccessCredentials,
): ClientOptions {
  const options: ClientOptions = {
    maxPayload: MAX_PAYLOAD_BYTES,
    ...(cloudflareAccess ? { headers: buildCloudflareAccessHeaders(cloudflareAccess) } : {}),
  };
  if (tlsFingerprint?.trim()) {
    applyGatewayWebSocketTlsPin(options, tlsFingerprint);
  }
  return options;
}

async function waitForSocketConnect(socket: net.Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

async function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

async function sendAttachMetadata(
  ws: WebSocket,
  metadata: Record<string, string | boolean>,
): Promise<void> {
  const buffer = Buffer.from(JSON.stringify(metadata), "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      ws.send(buffer, { binary: true }, (error) => (error ? reject(error) : resolve()));
    });
  } finally {
    buffer.fill(0);
  }
}

function createNodeStreamSplice(params: {
  socket: Duplex;
  ws: WebSocket;
  streamName: string;
  diagnostics: NodeStreamDiagnostics;
}) {
  let resumeTimer: ReturnType<typeof setInterval> | undefined;
  let settled = false;
  let finish!: (trigger: NodeStreamCloseTrigger, error?: Error) => void;
  const resumeWebSocket = () => params.ws.resume();
  const onMessage = (data: RawData, isBinary: boolean) => {
    if (params.socket.destroyed || params.socket.writableEnded) {
      return;
    }
    if (!isBinary) {
      finish(
        "invalid-frame",
        new Error(`gateway sent non-binary ${params.streamName} stream data`),
      );
      return;
    }
    if (!params.socket.write(websocketDataBuffer(data))) {
      params.ws.pause();
    }
  };
  const stopInbound = () => {
    params.ws.off("message", onMessage);
    params.socket.off("drain", resumeWebSocket);
    // A closed target cannot emit drain, but WebSocket close frames still need reads.
    params.ws.resume();
  };
  const done = new Promise<void>((resolve, reject) => {
    finish = (trigger, error) => {
      if (settled) {
        return;
      }
      params.diagnostics.trigger ??= trigger;
      settled = true;
      clearInterval(resumeTimer);
      stopInbound();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    params.ws.on("message", onMessage);
    params.socket.on("drain", resumeWebSocket);
    params.socket.on("data", (chunk) => {
      if (params.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      params.ws.send(chunk, { binary: true }, (error) => error && finish("send-error", error));
      if (params.ws.bufferedAmount <= PAUSE_BUFFERED_BYTES || resumeTimer) {
        return;
      }
      params.socket.pause();
      resumeTimer = setInterval(() => {
        if (params.ws.bufferedAmount <= PAUSE_BUFFERED_BYTES) {
          clearInterval(resumeTimer);
          resumeTimer = undefined;
          params.socket.resume();
        }
      }, RESUME_CHECK_MS);
      resumeTimer.unref?.();
    });
    params.ws.once("close", () => finish("websocket-close"));
    params.ws.once("error", (error) => finish("websocket-error", error));
    params.socket.once("close", () => {
      params.diagnostics.trigger ??= "target-close";
      stopInbound();
      if (params.socket.readableEnded && params.ws.readyState === WebSocket.OPEN) {
        // Let the Gateway receive the last frames and close acknowledgement before
        // the control-channel invocation can retire its desktop/portal stream.
        params.ws.close();
      } else {
        finish("target-close");
      }
    });
    params.socket.once("error", (error) => finish("target-error", error));
  });
  void done.catch(() => undefined);
  return {
    done,
    start() {
      if (params.socket.destroyed || params.ws.readyState !== WebSocket.OPEN) {
        finish("splice-unavailable");
        return;
      }
      params.socket.resume();
      params.ws.resume();
    },
  };
}

/** Pairs an enrolled Gateway attach socket with a node-owned loopback connection. */
export async function runNodeStreamTransport(params: {
  gatewayUrl: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
  attachPath: string;
  expectedAttachPath: string;
  target: { stream: Duplex } | { port: number };
  metadata: Record<string, string | boolean>;
  streamName: string;
  signal: AbortSignal;
  emitStatus?: (status: string) => Promise<void>;
}): Promise<void> {
  const socket = "stream" in params.target ? params.target.stream : new net.Socket();
  // Loopback peers may send immediately; retain their first bytes until metadata is accepted.
  socket.pause();
  const diagnostics: NodeStreamDiagnostics = {};
  let ws: WebSocket | undefined;
  let aborted: boolean = params.signal.aborted;
  let resolveAbort!: () => void;
  const abort = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = () => {
    diagnostics.trigger ??= "owner-abort";
    aborted = true;
    socket.destroy();
    ws?.terminate();
    resolveAbort();
  };
  params.signal.addEventListener("abort", onAbort, { once: true });
  if (aborted) {
    onAbort();
  }
  try {
    if (aborted) {
      return;
    }
    ws = new WebSocket(
      attachWebSocketUrl(params),
      websocketOptions(params.gatewayTlsFingerprint, params.gatewayCloudflareAccess),
    );
    ws.once("error", () => {
      diagnostics.trigger ??= "websocket-error";
    });
    ws.once("close", (closeCode) => {
      // Owner teardown can also produce 1006; retain its earlier trigger separately.
      streamLog.info("node stream closed", {
        streamKind: params.streamName,
        trigger: diagnostics.trigger ?? "websocket-close",
        closeCode,
      });
    });
    await Promise.race([waitForWebSocketOpen(ws), abort]);
    if (aborted) {
      return;
    }
    if ("port" in params.target && socket instanceof net.Socket) {
      // Portals attach first so a refused target closes the claimed ticket.
      socket.connect({ port: params.target.port, host: "localhost", autoSelectFamily: true });
      await Promise.race([waitForSocketConnect(socket), abort]);
    }
    if (aborted) {
      return;
    }
    if (socket.destroyed) {
      throw socket.errored ?? new Error(`${params.streamName} stream target closed before attach`);
    }
    ws.pause();
    const splice = createNodeStreamSplice({
      socket,
      ws,
      streamName: params.streamName,
      diagnostics,
    });
    await sendAttachMetadata(ws, params.metadata);
    void params.emitStatus?.(`${params.streamName} stream attached\n`).catch(() => undefined);
    splice.start();
    await splice.done;
  } catch (error) {
    diagnostics.trigger ??= "startup-error";
    if (!aborted) {
      throw error;
    }
  } finally {
    params.signal.removeEventListener("abort", onAbort);
    socket.destroy();
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
  }
}
