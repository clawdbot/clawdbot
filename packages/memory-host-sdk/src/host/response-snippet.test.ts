// Memory Host SDK tests cover response snippet behavior.
import { describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../../../test/helpers/promise.js";
import {
  readMemoryHostResponseTextSnippet,
  readResponseJsonWithLimit,
} from "./response-snippet.js";
import { createPendingResponse } from "./response-snippet.test-harness.js";

describe("readMemoryHostResponseTextSnippet", () => {
  it.each(["prefix", "overflow", "length", "preabort"] as const)(
    "settles %s reads while a response clone remains open",
    async (kind) => {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("abcdefgh"));
          },
          cancel,
        }),
        { headers: kind === "length" ? { "content-length": "16" } : {} },
      );
      const capture = response.clone();
      const parent = new AbortController();
      const expected = new Error("reader aborted");
      parent.abort(expected);
      const operation = (
        kind === "prefix" || kind === "preabort"
          ? readMemoryHostResponseTextSnippet(response, {
              maxBytes: 4,
              signal: kind === "preabort" ? parent.signal : undefined,
            })
          : readResponseJsonWithLimit(response, { maxBytes: 4, errorPrefix: "fixture" })
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        const result = await Promise.race([
          operation,
          new Promise<undefined>((resolve) => {
            setImmediate(() => resolve(undefined));
          }),
        ]);
        if (kind === "prefix") {
          expect(result).toEqual({ value: "abcd... [truncated]" });
        } else if (kind === "preabort") {
          expect(result).toEqual({ error: expected });
        } else {
          expect(result).toEqual({
            error: new Error(
              `fixture: response body too large: ${kind === "length" ? 16 : 8} bytes (limit: 4 bytes)`,
            ),
          });
        }
        expect(response.body?.locked).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        await capture.body?.cancel();
        await operation;
      }
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("does not wait for another chunk after reading the byte cap exactly", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abcd"));
      },
      cancel() {
        canceled = true;
      },
    });

    await expect(
      readMemoryHostResponseTextSnippet(new Response(stream), { maxBytes: 4, maxChars: 100 }),
    ).resolves.toBe("abcd... [truncated]");
    expect(canceled).toBe(true);
  });

  it("does not split surrogate pairs when truncating text snippets", async () => {
    await expect(
      readMemoryHostResponseTextSnippet(new Response("abc🤖tail"), { maxChars: 4 }),
    ).resolves.toBe("abc... [truncated]");
  });

  it("drops partial UTF-8 characters when byte-capped snippets truncate a stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("ab" + String.fromCodePoint(0x1f600) + "cd"));
      },
      cancel() {},
    });

    await expect(
      readMemoryHostResponseTextSnippet(new Response(stream), { maxBytes: 3, maxChars: 100 }),
    ).resolves.toBe("ab... [truncated]");
  });

  it("cancels snippet body reads when the caller signal aborts", async () => {
    const fixture = createPendingResponse();
    const controller = new AbortController();
    const expected = new Error("snippet aborted");
    const read = readMemoryHostResponseTextSnippet(fixture.response, {
      maxBytes: 1024,
      signal: controller.signal,
    });
    const settled = read.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await withTestTimeout(fixture.readStarted, 1_000, "snippet read did not start");
      expect(fixture.response.body?.locked).toBe(true);
      controller.abort(expected);

      await expect(withTestTimeout(settled, 1_000, "snippet abort did not settle")).resolves.toBe(
        expected,
      );
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(fixture.response.body?.locked).toBe(false);
    } finally {
      controller.abort(expected);
      fixture.dispose();
      await withTestTimeout(settled, 1_000, "snippet cleanup did not settle");
    }
  });

  it.each([undefined, '{"ok":true}'])(
    "cancels JSON body reads when the caller signal aborts (prefix: %s)",
    async (prefix) => {
      const fixture = createPendingResponse({ prefix });
      const controller = new AbortController();
      const expected = new Error("json aborted");
      const read = readResponseJsonWithLimit(fixture.response, {
        errorPrefix: "remote memory",
        signal: controller.signal,
      });
      const settled = read.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await withTestTimeout(fixture.readStarted, 1_000, "JSON read did not start");
        expect(fixture.response.body?.locked).toBe(true);
        controller.abort(expected);

        await expect(withTestTimeout(settled, 1_000, "JSON abort did not settle")).resolves.toBe(
          expected,
        );
        expect(fixture.cancel).toHaveBeenCalledOnce();
        expect(fixture.response.body?.locked).toBe(false);
      } finally {
        controller.abort(expected);
        fixture.dispose();
        await withTestTimeout(settled, 1_000, "JSON cleanup did not settle");
      }
    },
  );

  it("rejects a JSON body with invalid UTF-8 bytes", async () => {
    const body = new Uint8Array([
      ...new TextEncoder().encode('{"ok":"val'),
      0xff,
      ...new TextEncoder().encode('ue"}'),
    ]);

    await expect(
      readResponseJsonWithLimit(new Response(body), { errorPrefix: "remote memory" }),
    ).rejects.toThrow(/not valid for encoding/);
  });
});
