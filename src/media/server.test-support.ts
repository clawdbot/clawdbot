import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";

type MediaTestServer = Awaited<ReturnType<typeof import("./server.js").startMediaServer>>;
type UndiciFetch = typeof import("undici").fetch;

export const LOOPBACK_FETCH_ENV = {
  HTTP_PROXY: undefined,
  HTTPS_PROXY: undefined,
  ALL_PROXY: undefined,
  http_proxy: undefined,
  https_proxy: undefined,
  all_proxy: undefined,
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
} as const;

export interface MediaServerTestHarness {
  fetch: UndiciFetch;
  listenBlocked: boolean;
  port: number;
  url: (mediaPath: string) => string;
  cleanup: () => Promise<void>;
}

function isListenPermissionError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES")
  );
}

export async function startMediaServerTestHarness(params: {
  setupMediaRoot: () => Promise<void>;
  cleanupMediaRoot: () => Promise<void>;
  cleanupTtlMs?: number;
}): Promise<MediaServerTestHarness> {
  vi.useRealTimers();
  vi.doUnmock("undici");

  const require = createRequire(import.meta.url);
  const { startMediaServer } = await import("./server.js");
  const { fetch } = require("undici") as typeof import("undici");

  let server: MediaTestServer | undefined;
  let listenBlocked = false;
  let port = 0;

  await params.setupMediaRoot();

  try {
    server = await startMediaServer(0, params.cleanupTtlMs ?? 1_000);
  } catch (error) {
    if (!isListenPermissionError(error)) {
      throw error;
    }
    listenBlocked = true;
  }

  if (server) {
    port = (server.address() as AddressInfo).port;
  }

  return {
    fetch,
    listenBlocked,
    port,
    url: (mediaPath: string) => `http://127.0.0.1:${port}/media/${mediaPath}`,
    cleanup: async () => {
      if (server) {
        await new Promise((resolve) => server?.close(resolve));
      }
      await params.cleanupMediaRoot();
    },
  };
}
