// Gateway HTTP boundary helpers coordinate request and upgrade work with host suspension.
import type { ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { tryBeginGatewayRootWorkAdmission } from "../../process/gateway-work-admission.js";

type GatewayBoundaryHandler = () => Promise<boolean> | boolean;

async function runWithGatewayBoundaryWorkAdmission(
  reject: () => void,
  run: GatewayBoundaryHandler,
): Promise<boolean> {
  const admission = tryBeginGatewayRootWorkAdmission();
  if (!admission) {
    reject();
    return true;
  }
  try {
    return await admission.run(async () => await run());
  } finally {
    admission.release();
  }
}

/** Runs one HTTP user-work route under the same root fence as Gateway RPCs. */
export async function runWithGatewayHttpWorkAdmission(
  res: ServerResponse,
  run: GatewayBoundaryHandler,
): Promise<boolean> {
  return await runWithGatewayBoundaryWorkAdmission(() => {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "1");
    res.end(
      JSON.stringify({
        error: {
          message: "Gateway is temporarily unavailable while suspending or restarting",
          type: "service_unavailable",
          code: "gateway_unavailable",
        },
      }),
    );
  }, run);
}

export function writeGatewayUpgradeServiceUnavailable(
  socket: Pick<Duplex, "write">,
  body: string,
): void {
  socket.write(
    "HTTP/1.1 503 Service Unavailable\r\n" +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n` +
      "\r\n" +
      body,
  );
}

/** Holds upgrade admission until one plugin handler owns or declines the socket. */
export async function runWithGatewayUpgradeWorkAdmission(
  socket: Duplex,
  run: GatewayBoundaryHandler,
): Promise<boolean> {
  return await runWithGatewayBoundaryWorkAdmission(() => {
    writeGatewayUpgradeServiceUnavailable(socket, "Gateway websocket admission closed");
    socket.destroy();
  }, run);
}
