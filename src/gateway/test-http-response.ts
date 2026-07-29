// Gateway HTTP test helpers build minimal request/response doubles and collect
// client response bodies.
import type { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

/**
 * Minimal HTTP response mock used by gateway handler tests.
 */
export function makeMockHttpResponse(): {
  res: ServerResponse;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const stream = new PassThrough();
  const streamEnd = stream.end.bind(stream);
  const setHeader = vi.fn();
  const end = vi.fn((chunk?: unknown) => {
    if (chunk !== undefined) {
      stream.write(chunk as string | Uint8Array);
    }
    streamEnd();
  });
  const res = Object.assign(stream, {
    headersSent: false,
    statusCode: 200,
    setHeader,
    end,
  }) as unknown as ServerResponse;
  return { res, setHeader, end };
}

export function makeMockHttpReqRes(
  reqSocket: EventEmitter | null,
  resSocket: EventEmitter | null,
): { req: IncomingMessage; res: ServerResponse } {
  return {
    req: { socket: reqSocket } as unknown as IncomingMessage,
    res: { socket: resSocket } as unknown as ServerResponse,
  };
}

export async function readClientResponseBody(
  res: IncomingMessage,
): Promise<{ status: number; body: string }> {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => {
    body += chunk;
  });
  await new Promise<void>((resolve) => {
    res.once("end", resolve);
  });
  return { status: res.statusCode ?? 0, body };
}
