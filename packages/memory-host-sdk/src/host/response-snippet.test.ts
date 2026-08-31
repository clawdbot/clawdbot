// Memory Host SDK tests cover response snippet behavior.
import { describe, expect, it, vi } from "vitest";
import {
  readMemoryHostResponseTextSnippet,
  readResponseJsonWithLimit,
} from "./response-snippet.js";

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

  function stallingResponse(onCancel: () => void): Response {
    const reader = {
      read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
      cancel: async () => {
        onCancel();
      },
      releaseLock: () => undefined,
    } as ReadableStreamDefaultReader<Uint8Array>;

    return {
      body: { getReader: () => reader },
      headers: new Headers(),
    } as Response;
  }

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
    let canceled = false;
    const response = stallingResponse(() => {
      canceled = true;
    });
    const controller = new AbortController();
    const read = readMemoryHostResponseTextSnippet(response, {
      maxBytes: 1024,
      signal: controller.signal,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    controller.abort(new Error("snippet aborted"));

    await expect(read).rejects.toThrow("snippet aborted");
    expect(canceled).toBe(true);
  });

  it("cancels JSON body reads when the caller signal aborts", async () => {
    let canceled = false;
    const response = stallingResponse(() => {
      canceled = true;
    });
    const controller = new AbortController();
    const read = readResponseJsonWithLimit(response, {
      errorPrefix: "remote memory",
      signal: controller.signal,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    controller.abort(new Error("json aborted"));

    await expect(read).rejects.toThrow("json aborted");
    expect(canceled).toBe(true);
  });

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
