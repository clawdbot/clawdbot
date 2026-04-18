import { readResponseWithLimit as readSharedResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";

export async function readResponseWithLimit(
  res: Response,
  maxBytes: number,
  opts?: {
    onOverflow?: (params: { size: number; maxBytes: number; res: Response }) => Error;
    chunkTimeoutMs?: number;
    onIdleTimeout?: (params: { chunkTimeoutMs: number }) => Error;
  },
): Promise<Buffer> {
  return await readSharedResponseWithLimit(res, maxBytes, {
    ...opts,
    onIdleTimeout:
      opts?.onIdleTimeout ??
      (({ chunkTimeoutMs }) =>
        new Error(`Matrix media download stalled: no data received for ${chunkTimeoutMs}ms`)),
  });
}
