import net from "node:net";
import { WebSocket, type ClientOptions, type RawData } from "ws";
import {
  buildCloudflareAccessHeaders,
  type CloudflareAccessCredentials,
} from "../../packages/gateway-client/src/cloudflare-access.js";
import { applyGatewayWebSocketTlsPin } from "../../packages/gateway-client/src/websocket-transport.js";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const PAUSE_BUFFERED_BYTES = 4 * 1024 * 1024;
const RESUME_CHECK_MS = 25;

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

function createNodeStreamSplice(params: { socket: net.Socket; ws: WebSocket; streamName: string }) {
  let resumeTimer: ReturnType<typeof setInterval> | undefined;
  let settled = false;
  let finish!: (error?: Error) => void;
  const done = new Promise<void>((resolve, reject) => {
    finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(resumeTimer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    params.ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        finish(new Error(`gateway sent non-binary ${params.streamName} stream data`));
        return;
      }
      if (!params.socket.write(websocketDataBuffer(data))) {
        params.ws.pause();
        params.socket.once("drain", () => params.ws.resume());
      }
    });
    params.socket.on("data", (chunk) => {
      if (params.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      params.ws.send(chunk, { binary: true }, (error) => error && finish(error));
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
    params.ws.once("close", () => finish());
    params.ws.once("error", (error) => finish(error));
    params.socket.once("close", () => finish());
    params.socket.once("error", (error) => finish(error));
  });
  void done.catch(() => undefined);
  return {
    done,
    start() {
      if (params.socket.destroyed || params.ws.readyState !== WebSocket.OPEN) {
        finish();
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
  port: number;
  metadata: Record<string, string | boolean>;
  streamName: string;
  signal: AbortSignal;
  connectAfterGatewayAttach?: boolean;
  emitStatus?: (status: string) => Promise<void>;
}): Promise<void> {
  const socket = params.connectAfterGatewayAttach
    ? new net.Socket()
    : net.createConnection(params.port, "127.0.0.1");
  // Loopback peers may send immediately; retain their first bytes until metadata is accepted.
  socket.pause();
  const wsUrl = attachWebSocketUrl(params);
  const ws = new WebSocket(
    wsUrl,
    websocketOptions(params.gatewayTlsFingerprint, params.gatewayCloudflareAccess),
  );
  let aborted: boolean = params.signal.aborted;
  let resolveAbort!: () => void;
  const abort = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = () => {
    aborted = true;
    socket.destroy();
    ws.terminate();
    resolveAbort();
  };
  params.signal.addEventListener("abort", onAbort, { once: true });
  if (aborted) {
    onAbort();
  }
  try {
    if (params.connectAfterGatewayAttach) {
      // Attach first so a refused target closes a claimed ticket instead of leaving it pending.
      await Promise.race([waitForWebSocketOpen(ws), abort]);
      if (!aborted) {
        // Like Gateway-local portals, reach dev servers bound to either localhost family.
        socket.connect({ port: params.port, host: "localhost", autoSelectFamily: true });
        await Promise.race([waitForSocketConnect(socket), abort]);
      }
    } else {
      await Promise.race([
        Promise.all([waitForSocketConnect(socket), waitForWebSocketOpen(ws)]),
        abort,
      ]);
    }
    if (aborted) {
      return;
    }
    ws.pause();
    const splice = createNodeStreamSplice({ socket, ws, streamName: params.streamName });
    await sendAttachMetadata(ws, params.metadata);
    void params.emitStatus?.(`${params.streamName} stream attached\n`).catch(() => undefined);
    splice.start();
    await splice.done;
  } catch (error) {
    if (!aborted) {
      throw error;
    }
  } finally {
    params.signal.removeEventListener("abort", onAbort);
    socket.destroy();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
}
