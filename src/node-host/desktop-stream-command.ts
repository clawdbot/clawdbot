import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import type { DesktopHostConfig } from "../config/types.desktop.js";
import { classifyRfbSecurity, connectRfbServer } from "../gateway/desktop/rfb-probe.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { NODE_DESKTOP_ATTACH_PATH } from "../shared/node-desktop-stream.js";
import { parseNodeWorkerDesktopStreamInput } from "../worker/node-desktop-protocol.js";
import { runNodeStreamTransport } from "./node-stream-transport.js";

const DEFAULT_DESKTOP_PORT = 5900;
const PROBE_TIMEOUT_MS = 1_500;
const TICKET_PATTERN = /^[a-f0-9]{48}$/u;
const MAX_VNC_PASSWORD_BYTES = 4 * 1024;

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

async function readVncPassword(
  passwordFile: string | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (!passwordFile) {
    return undefined;
  }
  signal.throwIfAborted();
  const handle = await fs.open(passwordFile, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  const buffer = Buffer.alloc(MAX_VNC_PASSWORD_BYTES + 1);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("desktop password file must be a regular file");
    }
    if (stat.size > MAX_VNC_PASSWORD_BYTES) {
      throw new Error("desktop password file is too large");
    }
    signal.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    signal.throwIfAborted();
    if (bytesRead > MAX_VNC_PASSWORD_BYTES) {
      throw new Error("desktop password file is too large");
    }
    const password = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .replace(/[\r\n]+$/u, "");
    if (!password) {
      throw new Error("desktop password file is empty");
    }
    registerSecretValueForRedaction(password);
    return password;
  } finally {
    buffer.fill(0);
    await handle.close();
  }
}

/** Splices a node-local loopback RFB socket to a ticket-authenticated Gateway WebSocket. */
async function runNodeDesktopStreamCommand(params: {
  command: NodeDesktopStreamCommandParams;
  gatewayUrl: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
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
  const probe = await connectRfbServer({
    host: "127.0.0.1",
    port: params.target.port,
    timeoutMs: PROBE_TIMEOUT_MS,
    signal: params.signal,
  });
  if (probe.kind !== "rfb") {
    throw new Error(
      probe.kind === "not-rfb"
        ? "desktop stream target is not an RFB server"
        : "desktop stream loopback RFB server is unavailable",
    );
  }
  try {
    const auth = classifyRfbSecurity(probe.securityTypes);
    if (auth === "none") {
      throw new Error("refusing unauthenticated loopback RFB server");
    }
    if (auth === "unsupported") {
      throw new Error("loopback RFB server security is unsupported");
    }
    const vncPassword =
      auth === "vnc-password"
        ? await readVncPassword(params.passwordFile, params.signal)
        : undefined;
    if (params.signal.aborted) {
      return;
    }

    await runNodeStreamTransport({
      gatewayUrl: params.gatewayUrl,
      gatewayTlsFingerprint: params.gatewayTlsFingerprint,
      gatewayCloudflareAccess: params.gatewayCloudflareAccess,
      attachPath: params.command.attachPath,
      expectedAttachPath: NODE_DESKTOP_ATTACH_PATH,
      target: { stream: probe.stream },
      metadata: { auth, ...(vncPassword ? { vncPassword } : {}) },
      streamName: "desktop",
      signal: params.signal,
      emitStatus: params.emitStatus,
    });
  } finally {
    probe.stream.destroy();
  }
}

/** Runs the built-in command against the node-local desktop configuration. */
export async function invokeNodeDesktopStream(params: {
  paramsJSON?: string | null;
  gatewayUrl?: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
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
    ...(params.gatewayCloudflareAccess
      ? { gatewayCloudflareAccess: params.gatewayCloudflareAccess }
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

/** Runs the private worker command against provider-attested loopback RFB facts. */
export async function invokeNodeWorkerDesktopStream(params: {
  paramsJSON?: string | null;
  gatewayUrl?: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
  signal?: AbortSignal;
}): Promise<void> {
  if (!params.gatewayUrl || !params.signal) {
    throw new Error("node worker desktop gateway connection is unavailable");
  }
  const command = parseNodeWorkerDesktopStreamInput(params.paramsJSON);
  await runNodeDesktopStreamCommand({
    command,
    gatewayUrl: params.gatewayUrl,
    ...(params.gatewayTlsFingerprint
      ? { gatewayTlsFingerprint: params.gatewayTlsFingerprint }
      : {}),
    ...(params.gatewayCloudflareAccess
      ? { gatewayCloudflareAccess: params.gatewayCloudflareAccess }
      : {}),
    target: { host: "127.0.0.1", port: command.port },
    ...(command.passwordFilePath ? { passwordFile: command.passwordFilePath } : {}),
    signal: params.signal,
  });
}
