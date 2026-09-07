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

  it("awaits both upstream cancellation and owner release", async () => {
    const pullStarted = createDeferred();
    const cancelGate = createDeferred();
    const releaseGate = createDeferred();
    const release = vi.fn(async () => await releaseGate.promise);
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

    let settled = false;
    const cancellation = reader.cancel(reason).finally(() => {
      settled = true;
    });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(upstreamCancel).toHaveBeenCalledWith(reason);
      expect(release).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      cancelGate.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
    } finally {
      cancelGate.resolve();
      releaseGate.resolve();
      await cancellation;
      reader.releaseLock();
    }
    await expect(read).resolves.toEqual({ done: true, value: undefined });
  });

  it("releases a cancelled response before its capture tee settles", async () => {
    const sourceCancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: sourceCancel }));
    const capture = response.clone();
    const release = vi.fn(async () => await capture.body?.cancel("capture stopped"));
    const wrapped = responseWithRelease(response, release);
    let settled = false;
    const cancellation = wrapped.body?.cancel("consumer stopped").then(() => {
      settled = true;
    });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(release).toHaveBeenCalledTimes(1);
      expect(sourceCancel).toHaveBeenCalledTimes(1);
      expect(settled).toBe(true);
      expect(response.body?.locked).toBe(false);
    } finally {
      await capture.body?.cancel("test cleanup");
      await cancellation;
    }
  });

  it.each(["read", "cancel"] as const)("preserves release failure during %s", async (operation) => {
    const releaseError = new Error("release failed");
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        if (operation === "read") {
          controller.error(new Error("source failed"));
        }
      },
    });
    const release = vi.fn(async () => {
      throw releaseError;
    });
    const wrapped = responseWithRelease(new Response(source), release);
    const result = operation === "read" ? wrapped.text() : wrapped.body?.cancel();

    await expect(result).rejects.toBe(releaseError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("settles cancellation after release when upstream cancellation fails", async () => {
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("upstream cancellation failed");
      },
    });
    const release = vi.fn(async () => {});
    const wrapped = responseWithRelease(new Response(source), release);

    await expect(wrapped.body?.cancel()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
