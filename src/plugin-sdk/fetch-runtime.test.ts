/**
 * Tests plugin SDK fetch runtime helpers and fixture path behavior.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import { responseWithRelease } from "./fetch-runtime.js";

describe("plugin SDK fetch runtime", () => {
  let importProbeOutput = "";

  beforeAll(() => {
    const moduleUrl = pathToFileURL(path.resolve("src/plugin-sdk/fetch-runtime.ts")).href;
    const source = `
      const { getGlobalDispatcher } = await import("undici");
      const before = getGlobalDispatcher();
      await import(${JSON.stringify(moduleUrl)});
      if (getGlobalDispatcher() !== before) {
        throw new Error("undici global dispatcher was replaced");
      }
      console.log("ok");
    `;
    const env = { ...process.env };
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "OPENCLAW_DEBUG_PROXY_ENABLED",
    ]) {
      delete env[key];
    }

    importProbeOutput = execNodeEvalSync(source, { env, imports: ["tsx"] });
  });

  it("does not replace the undici global dispatcher on import", () => {
    expect(importProbeOutput.trim()).toBe("ok");
  });

  it.each([204, 205, 304])(
    "returns the original response for null-body status %s",
    async (status) => {
      const response = new Response(null, { status });
      let releaseCount = 0;

      const wrapped = responseWithRelease(response, async () => {
        releaseCount += 1;
      });

      expect(wrapped).toBe(response);
      await vi.waitFor(() => expect(releaseCount).toBe(1));
    },
  );

  it("closes downstream EOF before awaiting release", async () => {
    const releaseGate = createDeferred();
    const releaseFinished = createDeferred();
    const wrapped = responseWithRelease(new Response("complete"), async () => {
      await releaseGate.promise;
      releaseFinished.resolve();
    });
    const reader = wrapped.body?.getReader();
    if (!reader) {
      throw new Error("expected wrapped response body");
    }

    await expect(reader.read()).resolves.toMatchObject({ done: false });
    const eof = reader.read();
    let eofSettled = false;
    void eof.then(() => {
      eofSettled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(eofSettled).toBe(true);
    await expect(eof).resolves.toEqual({ done: true, value: undefined });
    releaseGate.resolve();
    await releaseFinished.promise;
  });

  it("awaits upstream cancellation before release", async () => {
    const pullStarted = createDeferred();
    const cancelGate = createDeferred();
    const release = vi.fn(async () => {});
    const reason = new Error("consumer stopped");
    const upstreamCancel = vi.fn(async () => {
      await cancelGate.promise;
    });
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          pullStarted.resolve();
        },
        cancel: upstreamCancel,
      }),
    );
    const wrapped = responseWithRelease(response, release);
    const reader = wrapped.body?.getReader();
    if (!reader) {
      throw new Error("expected wrapped response body");
    }
    const read = reader.read();
    await pullStarted.promise;

    const cancellation = reader.cancel(reason);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(upstreamCancel).toHaveBeenCalledWith(reason);
    expect(release).not.toHaveBeenCalled();

    cancelGate.resolve();
    await cancellation;
    await expect(read).resolves.toEqual({ done: true, value: undefined });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
