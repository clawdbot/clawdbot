/**
 * Tests plugin SDK fetch runtime helpers and fixture path behavior.
 */
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
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

  it.each([200, 204, 205, 304])(
    "returns the original response for null-body status %s",
    async (status) => {
      const response = new Response(null, { status });
      let releaseCount = 0;

      const wrapped = responseWithRelease(response, {
        kind: "transport",
        release: async () => {
          releaseCount += 1;
        },
      });

      expect(wrapped).toBe(response);
      await vi.waitFor(() => expect(releaseCount).toBe(1));
    },
  );

  it("observes null-body cleanup rejection without replacing the response", async () => {
    const response = new Response(null);
    const release = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    expect(responseWithRelease(response, { kind: "transport", release })).toBe(response);
    await nextTurn();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["transport", "after-body"] as const)(
    "exposes EOF before %s cleanup settles",
    async (kind) => {
      const releaseGate = createDeferred();
      const releaseFinished = createDeferred();
      const release = vi.fn(async () => {
        await releaseGate.promise;
        releaseFinished.resolve();
      });
      const response = new Response("complete", {
        status: 201,
        statusText: "Created",
        headers: { "x-fixture": "preserved" },
      });
      const wrapped = responseWithRelease(response, { kind, release });
      const reader = wrapped.body?.getReader();
      if (!reader) {
        throw new Error("expected wrapped response body");
      }

      await expect(reader.read()).resolves.toEqual({
        done: false,
        value: new TextEncoder().encode("complete"),
      });
      const eof = reader.read();
      let eofSettled = false;
      void eof.then(() => {
        eofSettled = true;
      });
      await nextTurn();

      expect(eofSettled).toBe(true);
      expect(response.body?.locked).toBe(false);
      expect(wrapped.status).toBe(201);
      expect(wrapped.statusText).toBe("Created");
      expect(wrapped.headers.get("x-fixture")).toBe("preserved");
      expect(release).toHaveBeenCalledOnce();
      await expect(eof).resolves.toEqual({ done: true, value: undefined });
      releaseGate.resolve();
      await releaseFinished.promise;
      reader.releaseLock();
    },
  );

  it.each(
    (["transport", "after-body"] as const).flatMap((kind) =>
      [false, true].flatMap((releaseFails) =>
        [false, true].map((cancelFails) => ({ kind, releaseFails, cancelFails })),
      ),
    ),
  )(
    "joins held $kind cancellation (releaseFails=$releaseFails, cancelFails=$cancelFails)",
    async ({ kind, releaseFails, cancelFails }) => {
      const pullStarted = createDeferred();
      const cancelGate = createDeferred();
      const releaseGate = createDeferred();
      const releaseError = new Error("cleanup failed");
      const release = vi.fn(async () => {
        if (releaseFails) {
          throw releaseError;
        }
        await releaseGate.promise;
      });
      const reason = new Error("consumer stopped");
      const upstreamCancel = vi.fn(async () => {
        await cancelGate.promise;
        if (cancelFails) {
          throw new Error("source cancellation failed");
        }
      });
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            pullStarted.resolve();
          },
          cancel: upstreamCancel,
        }),
      );
      const wrapped = responseWithRelease(response, { kind, release });
      const reader = wrapped.body?.getReader();
      if (!reader) {
        throw new Error("expected wrapped response body");
      }
      const read = reader.read();
      await pullStarted.promise;

      let settled = false;
      const cancellation = reader
        .cancel(reason)
        .then(
          () => undefined,
          (error: unknown) => error,
        )
        .finally(() => {
          settled = true;
        });
      try {
        await nextTurn();
        expect(upstreamCancel).toHaveBeenCalledWith(reason);
        expect(release).toHaveBeenCalledTimes(kind === "transport" ? 1 : 0);
        expect(settled).toBe(false);
        expect(response.body?.locked).toBe(false);
        await expect(read).resolves.toEqual({ done: true, value: undefined });
        cancelGate.resolve();
        await nextTurn();
        expect(release).toHaveBeenCalledOnce();
        expect(settled).toBe(releaseFails);
        releaseGate.resolve();
        expect(await cancellation).toBe(releaseFails ? releaseError : undefined);
        await reader.cancel("already closed");
        expect(release).toHaveBeenCalledOnce();
      } finally {
        cancelGate.resolve();
        releaseGate.resolve();
        await cancellation;
        reader.releaseLock();
      }
    },
  );

  it.each([false, true])(
    "preserves read-error precedence (releaseFails=%s)",
    async (releaseFails) => {
      const sourceError = new Error("source failed");
      const releaseError = new Error("cleanup failed");
      const release = vi.fn(() => {
        if (releaseFails) {
          throw releaseError;
        }
      });
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(sourceError);
          },
        }),
      );
      const wrapped = responseWithRelease(response, { kind: "transport", release });
      await expect(wrapped.text()).rejects.toBe(releaseFails ? releaseError : sourceError);
      expect(response.body?.locked).toBe(false);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("releases a captured transport without waiting for the retained clone", async () => {
    const releaseGate = createDeferred();
    const sourceController = createDeferred<ReadableStreamDefaultController<Uint8Array>>();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          sourceController.resolve(controller);
          controller.enqueue(new TextEncoder().encode("prefix"));
        },
      }),
    );
    const upstreamController = await sourceController.promise;
    const captured = response
      .clone()
      .arrayBuffer()
      .catch(() => undefined);
    const release = vi.fn(async () => {
      upstreamController.error(new Error("request transport released"));
      await releaseGate.promise;
    });
    const wrapped = responseWithRelease(response, { kind: "transport", release });
    const reader = wrapped.body?.getReader();
    if (!reader) {
      throw new Error("expected wrapped response body");
    }
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    let settled = false;
    const cancellation = reader.cancel("consumer stopped").finally(() => {
      settled = true;
    });
    try {
      await nextTurn();
      expect(release).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(response.body?.locked).toBe(false);
      releaseGate.resolve();
      await cancellation;
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      upstreamController.error(new Error("test cleanup"));
      releaseGate.resolve();
      await cancellation;
      await captured;
      reader.releaseLock();
    }
  });
});
