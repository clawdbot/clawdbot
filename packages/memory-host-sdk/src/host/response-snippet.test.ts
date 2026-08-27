// Memory Host SDK tests cover response snippet behavior.
import { describe, expect, it } from "vitest";
import {
  readMemoryHostResponseTextSnippet,
  readResponseJsonWithLimit,
} from "./response-snippet.js";

describe("readMemoryHostResponseTextSnippet", () => {
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
