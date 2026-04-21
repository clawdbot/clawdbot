import { vi } from "vitest";
import type { PluginRuntime } from "./runtime-api.js";

type FetchRemoteMediaParams = {
  url: string;
  maxBytes?: number;
  ssrfPolicy?: unknown;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

type FetchRemoteMediaHttpErrorParams = {
  response: Response;
  url: string;
};

export function createBlueBubblesFetchRemoteMediaMock(options: {
  createHttpError: (params: FetchRemoteMediaHttpErrorParams) => Error | Promise<Error>;
}) {
  return vi.fn(async (params: FetchRemoteMediaParams) => {
    const fetchFn = params.fetchImpl ?? fetch;
    const res = await fetchFn(params.url);
    if (!res.ok) {
      throw await options.createHttpError({ response: res, url: params.url });
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (typeof params.maxBytes === "number" && buffer.byteLength > params.maxBytes) {
      const error = new Error(`payload exceeds maxBytes ${params.maxBytes}`) as Error & {
        code?: string;
      };
      error.code = "max_bytes";
      throw error;
    }
    return {
      buffer,
      contentType: res.headers.get("content-type") ?? undefined,
      fileName: undefined,
    };
  });
}

export function createBlueBubblesRuntimeStub(
  fetchRemoteMediaMock: ReturnType<typeof createBlueBubblesFetchRemoteMediaMock>,
) {
  return {
    channel: {
      media: {
        fetchRemoteMedia:
          fetchRemoteMediaMock as unknown as PluginRuntime["channel"]["media"]["fetchRemoteMedia"],
      },
    },
  } as unknown as PluginRuntime;
}
