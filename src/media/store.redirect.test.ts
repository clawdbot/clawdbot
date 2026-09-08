// Media store remote-source tests cover canonical guarded-fetch delegation.
import fs from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinnedLookup } from "../infra/net/ssrf.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { saveMediaSource } from "./store.js";
import { setMediaStoreNetworkDepsForTest } from "./store.test-support.js";

const saveRemoteMediaMock = vi.hoisted(() => vi.fn());
const runtimeFetchMock = vi.hoisted(() => vi.fn());

vi.mock("./fetch.js", () => ({
  saveRemoteMedia: saveRemoteMediaMock,
}));
vi.mock("../infra/net/runtime-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/net/runtime-fetch.js")>()),
  fetchWithRuntimeDispatcherOrMockedGlobal: runtimeFetchMock,
}));

async function useActualSaveRemoteMedia(): Promise<void> {
  const actual = await vi.importActual<typeof import("./fetch.js")>("./fetch.js");
  saveRemoteMediaMock.mockImplementationOnce(actual.saveRemoteMedia);
}

describe("media store remote sources", () => {
  let testState: OpenClawTestState;

  beforeAll(async () => {
    testState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-media-store-remote-",
    });
  });

  beforeEach(() => {
    saveRemoteMediaMock.mockReset();
    runtimeFetchMock.mockReset();
    setMediaStoreNetworkDepsForTest({
      resolvePinnedHostname: async (hostname) => {
        const addresses = ["93.184.216.34"];
        return {
          hostname,
          addresses,
          lookup: createPinnedLookup({ hostname, addresses }),
        };
      },
    });
  });

  afterAll(async () => {
    try {
      setMediaStoreNetworkDepsForTest();
    } finally {
      await testState.cleanup();
    }
  });

  it("forwards the source contract to guarded fetch and keeps the SavedMedia shape", async () => {
    const source = "https://example.com/files/report.txt";
    const headers = { Authorization: "Bearer secret", Accept: "text/plain" };
    saveRemoteMediaMock.mockResolvedValueOnce({
      id: "stored.txt",
      path: "/tmp/stored.txt",
      size: 6,
      contentType: "text/plain",
      fileName: "report.txt",
    });

    const saved = await saveMediaSource(source, headers, "remote", 1234);

    expect(saveRemoteMediaMock).toHaveBeenCalledWith({
      url: source,
      requestInit: { headers },
      filePathHint: source,
      maxBytes: 1234,
      maxRedirects: 5,
      fetchImpl: expect.any(Function),
      responseHeaderTimeoutMs: 30_000,
      readIdleTimeoutMs: 30_000,
      originalFilename: "_.txt",
      subdir: "remote",
      lookupFn: expect.any(Function),
      ssrfPolicy: { allowedHostnames: ["example.com"] },
    });
    expect(saved).toStrictEqual({
      id: "stored.txt",
      path: "/tmp/stored.txt",
      size: 6,
      contentType: "text/plain",
    });
  });

  it("rejects unsafe subdirectories before starting a remote fetch", async () => {
    await expect(
      saveMediaSource("https://example.com/file.bin", undefined, "../outside"),
    ).rejects.toThrow("unsafe media subdir");
    expect(saveRemoteMediaMock).not.toHaveBeenCalled();
  });

  it("preserves an unmapped URL suffix through the canonical public flow", async () => {
    await useActualSaveRemoteMedia();
    runtimeFetchMock.mockResolvedValueOnce(
      new Response("custom", {
        status: 200,
        headers: { "content-type": "application/x-custom" },
      }),
    );

    const saved = await saveMediaSource(
      "https://example.com/files/report.custom?token=secret",
      undefined,
      "remote",
      1024,
    );

    expect(saved.id).toMatch(/^[a-f0-9-]{36}\.custom$/);
    expect(saved.id).not.toContain("report");
    await expect(fs.readFile(saved.path, "utf8")).resolves.toBe("custom");
  });

  it("reports HTTP failure while cancelling a nonempty never-ending body", async () => {
    await useActualSaveRemoteMedia();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    runtimeFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("synthetic upstream failure"));
          },
          cancel,
        }),
        {
          status: 500,
          statusText: "Internal Server Error",
        },
      ),
    );

    await expect(saveMediaSource("https://example.com/stalled-error.bin")).rejects.toMatchObject({
      name: "MediaFetchError",
      code: "http_error",
      status: 500,
      message:
        "Failed to fetch media from https://example.com/stalled-error.bin: HTTP 500 Internal Server Error",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports real HTTP failures while closing discarded bodies and retaining readable bodies", async () => {
    const media = await vi.importActual<typeof import("./fetch.js")>("./fetch.js");
    const transport = await vi.importActual<typeof import("../infra/net/runtime-fetch.js")>(
      "../infra/net/runtime-fetch.js",
    );
    saveRemoteMediaMock.mockImplementationOnce(media.saveRemoteMedia);
    runtimeFetchMock.mockImplementation(transport.fetchWithRuntimeDispatcher);
    setMediaStoreNetworkDepsForTest({
      resolvePinnedHostname: async (hostname) => {
        const addresses = ["127.0.0.1"];
        return { hostname, addresses, lookup: createPinnedLookup({ hostname, addresses }) };
      },
    });
    const responseClosed = createDeferredCore<boolean>();
    const socketClosed = createDeferredCore();
    const body = "synthetic upstream unavailable";

    await withEnvAsync({ no_proxy: "127.0.0.1" }, () =>
      withServer(
        (request, response) => {
          const leaveOpen = request.url === "/open-error";
          if (leaveOpen) {
            response.once("close", () => responseClosed.resolve(response.writableFinished));
            request.socket.once("close", () => socketClosed.resolve());
          }
          response.writeHead(503, "Service Unavailable", { "content-type": "text/plain" });
          if (leaveOpen) {
            response.write(body);
          } else {
            response.end(body);
          }
        },
        async (baseUrl) => {
          const openUrl = `${baseUrl}/open-error`;
          const failure = await saveMediaSource(openUrl, undefined, "real-http-error", 64).catch(
            (error: unknown) => error,
          );
          expect(failure).toMatchObject({
            name: "MediaFetchError",
            code: "http_error",
            status: 503,
          });
          // The helper destroys remaining sockets on exit; observe closure before checking the message.
          const [finished] = await Promise.all([responseClosed.promise, socketClosed.promise]);
          expect(finished).toBe(false);
          await expect(
            fs.readdir(testState.statePath("media", "real-http-error")),
          ).resolves.toEqual([]);

          const closedUrl = `${baseUrl}/closed-error`;
          await expect(
            media.readRemoteMediaBuffer({
              url: closedUrl,
              fetchImpl: transport.fetchWithRuntimeDispatcher,
              ssrfPolicy: { allowedOrigins: [baseUrl] },
            }),
          ).rejects.toMatchObject({
            name: "MediaFetchError",
            code: "http_error",
            status: 503,
            message: `Failed to fetch media from ${closedUrl}: HTTP 503 Service Unavailable; body: ${body}`,
          });
          expect(failure).toMatchObject({
            message: `Failed to fetch media from ${openUrl}: HTTP 503 Service Unavailable`,
          });
        },
      ),
    );
  });

  it("keeps redirect cancellation and cross-origin header stripping in the guard", async () => {
    await useActualSaveRemoteMedia();
    const cancel = vi.fn();
    runtimeFetchMock
      .mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 302,
          headers: { location: "https://cdn.example.com/asset.txt" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("redirected", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );

    const saved = await saveMediaSource("https://example.com/start", {
      Authorization: "Bearer secret",
      Accept: "text/plain",
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(runtimeFetchMock).toHaveBeenCalledTimes(2);
    const secondInit = runtimeFetchMock.mock.calls[1]?.[1] as RequestInit;
    const secondHeaders = new Headers(secondInit.headers);
    expect(secondHeaders.get("authorization")).toBeNull();
    expect(secondHeaders.get("accept")).toBe("text/plain");
    await expect(fs.readFile(saved.path, "utf8")).resolves.toBe("redirected");
    const expectedMode = process.platform === "win32" ? 0o666 : 0o644 & ~process.umask();
    expect((await fs.stat(saved.path)).mode & 0o777).toBe(expectedMode);
  });

  it.each([
    { name: "missing", location: undefined, expected: /missing location header/i },
    { name: "malformed", location: "http://[", expected: /invalid url/i },
  ])(
    "rejects a $name redirect location after cancelling its body",
    async ({ location, expected }) => {
      await useActualSaveRemoteMedia();
      const cancel = vi.fn();
      runtimeFetchMock.mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 302,
          headers: location ? { location } : undefined,
        }),
      );

      await expect(saveMediaSource("https://example.com/start")).rejects.toThrow(expected);
      expect(cancel).toHaveBeenCalledOnce();
      expect(runtimeFetchMock).toHaveBeenCalledOnce();
    },
  );
});
