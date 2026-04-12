import type { ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

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
