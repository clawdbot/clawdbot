import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";

export type WebSocketUpgradeRejection = {
  status: 400 | 401 | 403 | 404 | 426 | 429 | 503;
  reason?: string;
  body?: { contentType: string; text: string };
  headers?: Record<string, string>;
};

export function rejectWebSocketUpgrade(
  socket: Pick<Duplex, "end" | "destroy">,
  params: WebSocketUpgradeRejection,
): void {
  const response = [
    `HTTP/1.1 ${params.status} ${params.reason ?? STATUS_CODES[params.status]}`,
    "Connection: close",
    ...(params.body
      ? [
          `Content-Type: ${params.body.contentType}`,
          `Content-Length: ${Buffer.byteLength(params.body.text, "utf8")}`,
        ]
      : []),
    ...Object.entries(params.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
    "",
    params.body?.text ?? "",
  ].join("\r\n");
  try {
    // Reused HTTP sockets can buffer upgrade writes; destroy only after flushing.
    socket.end(response, () => socket.destroy());
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
