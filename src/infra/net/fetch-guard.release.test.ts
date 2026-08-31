import type { ServerResponse } from "node:http";
import type { Dispatcher } from "undici";
import { describe, expect, it } from "vitest";
import { createBoundedProviderBinaryStream } from "../../plugin-sdk/provider-binary-stream.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { captureHttpExchange } from "../../proxy-capture/runtime.js";
import type { CaptureEventRecord } from "../../proxy-capture/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readResponseTextPrefix, readResponseWithLimit } from "../http-body.js";
import { fetchWithSsrFGuard } from "./fetch-guard.js";
import { wrapGuardedBodyStream } from "./guarded-body-stream.js";
import { PinnedDispatcherPool } from "./pinned-dispatcher-pool.js";
import { fetchWithRuntimeDispatcher, type DispatcherAwareRequestInit } from "./runtime-fetch.js";

async function withinDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("guard release did not settle")), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("guarded request release", () => {
  it.each(["unread", "prefix", "overflow", "wrapped", "binary"] as const)(
    "ends only the %s request while a captured sibling keeps its pooled transport",
    async (readerKind) => {
      const abandonedClosed = createDeferredCore();
      const heldResponse = createDeferredCore<ServerResponse>();
      const parent = new AbortController();
      const pool = new PinnedDispatcherPool({ maxEntries: 1, idleTtlMs: 60_000 });
      const dispatchers: Array<Dispatcher | undefined> = [];
      const captures = new Map<string, ReturnType<typeof createDeferredCore<CaptureEventRecord>>>();
      const releases: Array<() => Promise<void>> = [];
      const fetchImpl = async (input: RequestInfo | URL, init?: DispatcherAwareRequestInit) => {
        dispatchers.push(init?.dispatcher);
        const url = input instanceof Request ? input.url : input.toString();
        const captured = createDeferredCore<CaptureEventRecord>();
        captures.set(new URL(url).pathname, captured);
        const response = await fetchWithRuntimeDispatcher(input, init);
        captureHttpExchange(
          { url, method: "GET", response },
          {
            enabled: true,
            required: false,
            dbPath: "unused-memory-sink",
            blobDir: "unused-memory-sink",
            certDir: "unused-memory-sink",
            sessionId: "guard-release-test",
            sourceProcess: "test",
          },
          {
            getStore: () => ({
              upsertSession() {},
              endSession() {},
              recordEvent(event) {
                if (event.kind === "response" || event.kind === "error") {
                  captured.resolve(event);
                }
              },
            }),
            persistEventPayload: (_store, { data }) =>
              Buffer.isBuffer(data) ? { dataText: data.toString("utf8") } : {},
          },
        );
        return response;
      };

      await withServer(
        (request, response) => {
          if (request.url === "/abandoned") {
            request.socket.once("close", () => abandonedClosed.resolve());
            response.writeHead(503);
            response.write("unused error body");
          } else if (request.url === "/held") {
            response.write("kept");
            heldResponse.resolve(response);
          } else {
            response.end("complete");
          }
        },
        async (baseUrl) => {
          let heldBody: Promise<Buffer> | undefined;
          let abandonedOperation: Promise<void> | undefined;
          const get = async (path: string) => {
            const result = await fetchWithSsrFGuard({
              url: `${baseUrl}${path}`,
              fetchImpl,
              signal: parent.signal,
              timeoutMs: 5_000,
              policy: { allowPrivateNetwork: true, hostnameAllowlist: ["127.0.0.1"] },
              dispatcherPool: pool,
            });
            releases.push(result.release);
            return result;
          };
          try {
            const abandoned = await get("/abandoned");
            const held = await get("/held");
            heldBody = readResponseWithLimit(held.response, 32);
            void heldBody.catch(() => undefined);
            expect(abandoned.response.status).toBe(503);
            expect(held.dispatcherReused).toBe(true);
            expect(dispatchers[0]).toBeDefined();
            expect(dispatchers[1]).toBe(dispatchers[0]);

            abandonedOperation = (async () => {
              const reason = new Error("body limit reached");
              if (readerKind === "wrapped") {
                const wrapped = wrapGuardedBodyStream({
                  body: abandoned.response.body!,
                  cleanup: abandoned.release,
                });
                const reader = wrapped.getReader();
                try {
                  expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
                  await reader.cancel(reason);
                } finally {
                  reader.releaseLock();
                }
                return;
              }
              try {
                if (readerKind === "prefix") {
                  expect(await readResponseTextPrefix(abandoned.response, 4)).toMatchObject({
                    text: "unus",
                    truncated: true,
                  });
                } else if (readerKind === "overflow") {
                  await expect(
                    readResponseWithLimit(abandoned.response, 4, {
                      onOverflow: () => reason,
                    }),
                  ).rejects.toBe(reason);
                } else if (readerKind === "binary") {
                  const bounded = createBoundedProviderBinaryStream(abandoned.response.body!, {
                    maxBytes: 4,
                    createOverflowError: () => reason,
                    createReleaseError: () => reason,
                    cleanup: abandoned.release,
                  });
                  const reader = bounded.stream.getReader();
                  try {
                    const chunks: Uint8Array[] = [];
                    await expect(
                      (async () => {
                        while (true) {
                          const chunk = await reader.read();
                          if (chunk.done) {
                            return;
                          }
                          chunks.push(chunk.value);
                        }
                      })(),
                    ).rejects.toBe(reason);
                    expect(Buffer.concat(chunks).toString()).toBe("unus");
                  } finally {
                    reader.releaseLock();
                    await bounded.release();
                  }
                }
              } finally {
                await abandoned.release();
              }
            })();
            await withinDeadline(abandonedOperation.then(() => abandonedClosed.promise));
            expect(parent.signal.aborted).toBe(false);
            expect(await withinDeadline(captures.get("/abandoned")!.promise)).toMatchObject({
              kind: "error",
            });

            (await heldResponse.promise).end("-alive");
            expect((await withinDeadline(heldBody)).toString("utf8")).toBe("kept-alive");
            await held.release();
            expect(await withinDeadline(captures.get("/held")!.promise)).toMatchObject({
              kind: "response",
              status: 200,
              dataText: "kept-alive",
            });

            const completed = await get("/complete");
            expect(completed.dispatcherReused).toBe(true);
            expect(dispatchers[2]).toBe(dispatchers[0]);
            expect((await readResponseWithLimit(completed.response, 32)).toString("utf8")).toBe(
              "complete",
            );
            await completed.release();
            expect(await withinDeadline(captures.get("/complete")!.promise)).toMatchObject({
              kind: "response",
              status: 200,
              dataText: "complete",
            });
            expect(parent.signal.aborted).toBe(false);
          } finally {
            parent.abort();
            await abandonedOperation?.catch(() => undefined);
            await heldBody?.catch(() => undefined);
            await Promise.all(releases.map((release) => release()));
            await pool.closeAll();
          }
        },
      );
    },
  );

  it.each(
    (["signal", "init"] as const).flatMap((source) =>
      [undefined, 5_000].map((timeoutMs) => ({ source, timeoutMs })),
    ),
  )(
    "preserves cancellation from $source with timeout $timeoutMs",
    async ({ source, timeoutMs }) => {
      const parent = new AbortController();
      const reason = new Error("caller stopped");
      await withServer(
        (_request, response) => response.write("unfinished"),
        async (baseUrl) => {
          const result = await fetchWithSsrFGuard({
            url: baseUrl,
            timeoutMs,
            ...(source === "signal"
              ? { signal: parent.signal }
              : { init: { signal: parent.signal } }),
            policy: { allowPrivateNetwork: true },
          });
          const body = readResponseWithLimit(result.response, 32);
          try {
            parent.abort(reason);
            await expect(withinDeadline(body)).rejects.toBe(reason);
            await result.release();
            expect(parent.signal.reason).toBe(reason);
          } finally {
            parent.abort();
            await result.release();
          }
        },
      );
    },
  );

  it("gives the explicit caller signal precedence over init.signal with a timeout", async () => {
    const parent = new AbortController();
    const ignored = new AbortController();
    const reason = new Error("explicit caller stopped");
    await withServer(
      (_request, response) => response.write("unfinished"),
      async (baseUrl) => {
        const result = await fetchWithSsrFGuard({
          url: baseUrl,
          signal: parent.signal,
          init: { signal: ignored.signal },
          timeoutMs: 5_000,
          policy: { allowPrivateNetwork: true },
        });
        const body = readResponseWithLimit(result.response, 32);
        try {
          ignored.abort(new Error("ignored init signal"));
          parent.abort(reason);
          await expect(withinDeadline(body)).rejects.toBe(reason);
        } finally {
          parent.abort();
          await result.release();
        }
      },
    );
  });
});
