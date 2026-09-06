import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { withServer } from "./http-test-server.js";

describe("withServer", () => {
  it.each([
    { outcome: "returns", rejectCallback: false },
    { outcome: "throws", rejectCallback: true },
  ])("closes an active response when its callback $outcome", async ({ rejectCallback }) => {
    const callbackError = new Error("callback failed");
    const started = createDeferredCore();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let streamEnded = false;
    const outcome = withServer(
      (_request, response) => {
        response.writeHead(200);
        response.write("stream started");
      },
      async (baseUrl) => {
        const response = await fetch(baseUrl);
        reader = response.body!.getReader();
        await reader.read();
        void reader.read().then(
          ({ done }) => {
            streamEnded = done;
          },
          () => {
            streamEnded = true;
          },
        );
        started.resolve();
        if (rejectCallback) {
          throw callbackError;
        }
      },
    ).then(
      () => undefined,
      (error: unknown) => {
        started.reject(error);
        return error;
      },
    );
    try {
      await started.promise;
      await vi.waitFor(() => expect(streamEnded).toBe(true));
      expect(await outcome).toBe(rejectCallback ? callbackError : undefined);
    } finally {
      await reader?.cancel().catch(() => undefined);
      await outcome;
    }
  });
});
