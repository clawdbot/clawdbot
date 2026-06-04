// Plugin SDK test helper for temporary local HTTP servers.
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";

/** Run an ephemeral loopback HTTP server for the duration of an async test callback. */
export async function withServer(handler: RequestListener, fn: (baseUrl: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
