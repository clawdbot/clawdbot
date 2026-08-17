import fs from "node:fs/promises";
import net from "node:net";
import type { TLSSocket } from "node:tls";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WebSocket, type ClientOptions, type RawData } from "ws";
import { normalizeTlsFingerprint } from "../../packages/gateway-client/src/client-address-utils.js";
import type { DesktopHostConfig } from "../config/types.desktop.js";
import { classifyRfbSecurity, probeRfbServer } from "../gateway/desktop/rfb-probe.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { NODE_DESKTOP_ATTACH_PATH } from "../shared/node-desktop-stream.js";

const DEFAULT_DESKTOP_PORT = 5900;
const PROBE_TIMEOUT_MS = 1_500;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const PAUSE_BUFFERED_BYTES = 4 * 1024 * 1024;
const RESUME_CHECK_MS = 25;
const TICKET_PATTERN = /^[a-f0-9]{48}$/u;

type NodeDesktopStreamCommandParams = {
  ticket: string;
  attachPath: string;
};

type NodeDesktopStreamTarget = {
  host: string;
  port: number;
};

function decodeDesktopStreamParams(raw?: string | null): NodeDesktopStreamCommandParams {
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : undefined;
  } catch {
    throw new Error("INVALID_REQUEST: desktop stream params malformed JSON");
  }
  if (!isRecord(value)) {
    throw new Error("INVALID_REQUEST: desktop stream params required");
  }
  const ticket = typeof value.ticket === "string" ? value.ticket.trim() : "";
  const attachPath = typeof value.attachPath === "string" ? value.attachPath.trim() : "";
  if (
    !TICKET_PATTERN.test(ticket) ||
    attachPath !== `${NODE_DESKTOP_ATTACH_PATH}?ticket=${ticket}`
  ) {
    throw new Error("INVALID_REQUEST: desktop stream ticket and attachPath required");
  }
  const attachUrl = new URL(attachPath, "http://127.0.0.1");
  if (attachUrl.searchParams.get("ticket") !== ticket) {
    throw new Error("INVALID_REQUEST: desktop stream ticket does not match attachPath");
  }
  if (Object.keys(value).some((key) => key !== "ticket" && key !== "attachPath")) {
    throw new Error("INVALID_REQUEST: desktop stream params contain unsupported fields");
  }
  return { ticket, attachPath };
}

function websocketDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

function attachWebSocketUrl(gatewayUrl: string, attachPath: string): string {
  const gateway = new URL(gatewayUrl);
  const url = new URL(attachPath, gateway);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("desktop stream gateway URL must use WebSocket transport");
  }
  if (url.origin !== gateway.origin || url.pathname !== NODE_DESKTOP_ATTACH_PATH) {
    throw new Error("desktop stream attachPath must stay on the connected gateway");
  }
  return url.toString();
}

function assertTlsSocketFingerprint(socket: TLSSocket, expectedRaw: string): void {
  const expected = normalizeTlsFingerprint(expectedRaw);
  const actual = normalizeTlsFingerprint(socket.getPeerCertificate().fingerprint256 ?? "");
  if (!expected || !actual || actual !== expected) {
    throw new Error("gateway TLS fingerprint mismatch");
  }
}

function createPinnedRequestFinisher(
  expected: string,
): NonNullable<ClientOptions["finishRequest"]> {
  return (request) => {
    request.once("socket", (socket) => {
      const tlsSocket = socket as TLSSocket;
      tlsSocket.once("secureConnect", () => {
        try {
          assertTlsSocketFingerprint(tlsSocket, expected);
          request.end();
        } catch (error) {
          request.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  };
}

function websocketOptions(url: string, tlsFingerprint?: string): ClientOptions {
  if (!url.startsWith("wss:") || !tlsFingerprint?.trim()) {
    return { maxPayload: MAX_PAYLOAD_BYTES };
  }
  return {
    maxPayload: MAX_PAYLOAD_BYTES,
    rejectUnauthorized: false,
    finishRequest: createPinnedRequestFinisher(tlsFingerprint),
  };
}

function assertGatewayTlsFingerprint(ws: WebSocket, expectedRaw?: string): void {
  if (!expectedRaw?.trim()) {
    return;
  }
  const expected = normalizeTlsFingerprint(expectedRaw);
  const socket = (
    ws as WebSocket & {
      _socket?: { getPeerCertificate?: () => { fingerprint256?: string } };
    }
  )["_socket"];
  const actual = normalizeTlsFingerprint(socket?.getPeerCertificate?.().fingerprint256 ?? "");
  if (!expected || !actual || actual !== expected) {
    throw new Error("gateway TLS fingerprint mismatch");
  }
}

async function readVncPassword(passwordFile?: string): Promise<string | undefined> {
  if (!passwordFile) {
    return undefined;
  }
  const password = (await fs.readFile(passwordFile, "utf8")).replace(/[\r\n]+$/u, "");
  if (!password) {
    throw new Error("desktop.host.passwordFile is empty");
  }
  registerSecretValueForRedaction(password);
  return password;
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
  metadata: { auth: "vnc-password" | "ard-account"; vncPassword?: string },
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

function createDesktopStreamSplice(params: { rfbSocket: net.Socket; ws: WebSocket }) {
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
        finish(new Error("gateway sent non-binary desktop stream data"));
        return;
      }
      if (!params.rfbSocket.write(websocketDataBuffer(data))) {
        params.ws.pause();
        params.rfbSocket.once("drain", () => params.ws.resume());
      }
    });
    params.rfbSocket.on("data", (chunk) => {
      if (params.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      params.ws.send(chunk, { binary: true }, (error) => error && finish(error));
      if (params.ws.bufferedAmount <= PAUSE_BUFFERED_BYTES || resumeTimer) {
        return;
      }
      params.rfbSocket.pause();
      resumeTimer = setInterval(() => {
        if (params.ws.bufferedAmount <= PAUSE_BUFFERED_BYTES) {
          clearInterval(resumeTimer);
          resumeTimer = undefined;
          params.rfbSocket.resume();
        }
      }, RESUME_CHECK_MS);
      resumeTimer.unref?.();
    });
    params.ws.once("close", () => finish());
    params.ws.once("error", (error) => finish(error));
    params.rfbSocket.once("close", () => finish());
    params.rfbSocket.once("error", (error) => finish(error));
  });
  void done.catch(() => undefined);
  return {
    done,
    start() {
      if (params.rfbSocket.destroyed || params.ws.readyState !== WebSocket.OPEN) {
        finish();
        return;
      }
      params.rfbSocket.resume();
      params.ws.resume();
    },
  };
}

/** Splices a node-local loopback RFB socket to a ticket-authenticated Gateway WebSocket. */
async function runNodeDesktopStreamCommand(params: {
  command: NodeDesktopStreamCommandParams;
  gatewayUrl: string;
  gatewayTlsFingerprint?: string;
  target: NodeDesktopStreamTarget;
  passwordFile?: string;
  signal: AbortSignal;
  emitStatus?: (status: string) => Promise<void>;
}): Promise<void> {
  if (params.target.host !== "127.0.0.1") {
    throw new Error("desktop stream target must be loopback");
  }
  if (
    !Number.isInteger(params.target.port) ||
    params.target.port < 1 ||
    params.target.port > 65535
  ) {
    throw new Error("desktop stream target port is invalid");
  }
  void params.emitStatus?.("probing local RFB server\n").catch(() => undefined);
  const probe = await probeRfbServer({
    host: "127.0.0.1",
    port: params.target.port,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (probe.kind !== "rfb") {
    throw new Error(
      probe.kind === "not-rfb"
        ? "desktop stream target is not an RFB server"
        : "desktop stream loopback RFB server is unavailable",
    );
  }
  const auth = classifyRfbSecurity(probe.securityTypes);
  if (auth === "none") {
    throw new Error("refusing unauthenticated loopback RFB server");
  }
  if (auth === "unsupported") {
    throw new Error("loopback RFB server security is unsupported");
  }
  const vncPassword =
    auth === "vnc-password" ? await readVncPassword(params.passwordFile) : undefined;
  if (params.signal.aborted) {
    return;
  }

  const rfbSocket = net.createConnection(params.target.port, "127.0.0.1");
  // The RFB server can send its banner as soon as TCP connects. Pause until the
  // attach metadata is accepted so no stateful handshake bytes are lost.
  rfbSocket.pause();
  const wsUrl = attachWebSocketUrl(params.gatewayUrl, params.command.attachPath);
  const ws = new WebSocket(wsUrl, websocketOptions(wsUrl, params.gatewayTlsFingerprint));
  let aborted: boolean = params.signal.aborted;
  let resolveAbort!: () => void;
  const abort = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = () => {
    aborted = true;
    rfbSocket.destroy();
    ws.terminate();
    resolveAbort();
  };
  params.signal.addEventListener("abort", onAbort, { once: true });
  if (aborted) {
    onAbort();
  }
  try {
    await Promise.race([
      Promise.all([waitForSocketConnect(rfbSocket), waitForWebSocketOpen(ws)]),
      abort,
    ]);
    if (aborted) {
      return;
    }
    assertGatewayTlsFingerprint(ws, params.gatewayTlsFingerprint);
    ws.pause();
    const splice = createDesktopStreamSplice({ rfbSocket, ws });
    await sendAttachMetadata(ws, { auth, ...(vncPassword ? { vncPassword } : {}) });
    void params.emitStatus?.("desktop stream attached\n").catch(() => undefined);
    splice.start();
    await splice.done;
  } catch (error) {
    if (!aborted) {
      throw error;
    }
  } finally {
    params.signal.removeEventListener("abort", onAbort);
    rfbSocket.destroy();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  }
}

/** Runs the built-in command against the node-local desktop configuration. */
export async function invokeNodeDesktopStream(params: {
  paramsJSON?: string | null;
  gatewayUrl?: string;
  gatewayTlsFingerprint?: string;
  config?: DesktopHostConfig;
  signal?: AbortSignal;
  emitStatus?: (status: string) => Promise<void>;
}): Promise<void> {
  if (!params.gatewayUrl || !params.signal) {
    throw new Error("desktop stream gateway connection is unavailable");
  }
  if (params.config?.enabled !== true) {
    throw new Error("desktop host streaming is disabled on this node");
  }
  const command = decodeDesktopStreamParams(params.paramsJSON);
  await runNodeDesktopStreamCommand({
    command,
    gatewayUrl: params.gatewayUrl,
    ...(params.gatewayTlsFingerprint
      ? { gatewayTlsFingerprint: params.gatewayTlsFingerprint }
      : {}),
    target: {
      host: "127.0.0.1",
      port: params.config.port ?? DEFAULT_DESKTOP_PORT,
    },
    ...(params.config.passwordFile ? { passwordFile: params.config.passwordFile } : {}),
    signal: params.signal,
    ...(params.emitStatus ? { emitStatus: params.emitStatus } : {}),
  });
}
