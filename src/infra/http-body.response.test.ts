// Tests bounded HTTP response reads and cleanup behavior.
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelUnreadResponseBody,
  readResponseTextPrefix,
  readResponseTextSnippet,
  readResponseWithLimit,
} from "./http-body.js";

function makeStream(chunks: Uint8Array[], delayMs?: number) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs) {
          await new Promise((resolve) => {
            setTimeout(resolve, delayMs);
          });
        }
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function makeStallingStream(
  initialChunks: Uint8Array[],
  onCancel?: UnderlyingSource<Uint8Array>["cancel"],
) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of initialChunks) {
        controller.enqueue(chunk);
      }
    },
    cancel: onCancel,
  });
}

function makeTricklingStream(intervalMs: number, onCancel?: (reason?: unknown) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = () => {
        if (cancelled) {
          return;
        }
        controller.enqueue(new Uint8Array([1]));
        timer = setTimeout(enqueue, intervalMs);
      };
      enqueue();
    },
    cancel(reason) {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
      onCancel?.(reason);
    },
  });
}

async function expectIdleTimeout(
  createReadPromise: () => Promise<unknown>,
  expectedError: RegExp | string = /stalled/i,
) {
  vi.useFakeTimers();
  try {
    const rejection = expect(createReadPromise()).rejects.toThrow(expectedError);
    await vi.advanceTimersByTimeAsync(60);
    await rejection;
  } finally {
    vi.useRealTimers();
  }
}

describe("cancelUnreadResponseBody", () => {
  it("cancels unread bodies and ignores cancellation failures", async () => {
    const cancel = vi.fn(() => {
      throw new Error("already closed");
    });
    const response = new Response(makeStallingStream([], cancel));

    await expect(cancelUnreadResponseBody(response)).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("leaves consumed and absent bodies alone", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("done"));
          controller.close();
        },
        cancel,
      }),
    );
    await response.text();

    await cancelUnreadResponseBody(response);
    await cancelUnreadResponseBody(undefined);

    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not wait for a retained response clone to finish cancellation", async () => {
    const cancel = vi.fn();
    const response = new Response(makeStallingStream([], cancel));
    const capture = response.clone();
    const cleanup = cancelUnreadResponseBody(response);
    try {
      const completed = await Promise.race([
        cleanup.then(() => true),
        new Promise<boolean>((resolve) => {
          setImmediate(() => resolve(false));
        }),
      ]);
      expect(completed).toBe(true);
      expect(response.bodyUsed).toBe(true);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      await capture.body?.cancel();
      await cleanup;
    }
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("readResponseWithLimit", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it.each(["prefix", "overflow", "deadline"] as const)(
    "settles %s reads before a retained response clone is released",
    async (kind) => {
      const cancel = vi.fn();
      const response = new Response(
        makeStallingStream([new TextEncoder().encode("abcdefgh")], cancel),
      );
      const capture = response.clone();
      const expected = new Error("read rejected");
      const operation = (
        kind === "prefix"
          ? readResponseTextPrefix(response, 8)
          : readResponseWithLimit(
              response,
              4,
              kind === "overflow"
                ? { onOverflow: () => expected }
                : {
                    timeoutMs: () => {
                      throw expected;
                    },
                  },
            )
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
        expect(result).toEqual(
          kind === "prefix"
            ? { value: { text: "abcdefgh", size: 8, truncated: true } }
            : { error: expected },
        );
        expect(response.body?.locked).toBe(false);
        expect(cancel).not.toHaveBeenCalled();
      } finally {
        await capture.body?.cancel();
        await operation;
      }
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("reads all chunks within the limit", async () => {
    const response = new Response(makeStream([new Uint8Array([1, 2]), new Uint8Array([3, 4])]));

    await expect(readResponseWithLimit(response, 100)).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it.each([0.5, 3.5])("reports overflow for a fractional byte budget of %s", async (maxBytes) => {
    const response = new Response(makeStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]));

    await expect(
      readResponseWithLimit(response, maxBytes, {
        onOverflow: ({ maxBytes: limit }) => new Error(`Exceeded ${limit} bytes`),
      }),
    ).rejects.toThrow(`Exceeded ${maxBytes} bytes`);
  });

  it.each([
    {
      name: "throws when total exceeds maxBytes",
      response: new Response(makeStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])])),
      maxBytes: 4,
      expectedError: /too large/i,
    },
    {
      name: "calls custom onOverflow",
      response: new Response(makeStream([new Uint8Array(10)])),
      maxBytes: 5,
      options: {
        onOverflow: ({ size, maxBytes: localMaxBytes }: { size: number; maxBytes: number }) =>
          new Error(`custom: ${size} > ${localMaxBytes}`),
      },
      expectedError: "custom: 10 > 5",
    },
  ] as const)("$name", async ({ response, maxBytes, options, expectedError }) => {
    await expect(readResponseWithLimit(response, maxBytes, options)).rejects.toThrow(expectedError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "rejects invalid maxBytes before reading: %s",
    async (maxBytes) => {
      await expect(
        readResponseWithLimit(new Response(makeStream([new Uint8Array([1, 2, 3])])), maxBytes),
      ).rejects.toThrow(/maxBytes must be a non-negative finite number/);
    },
  );

  it.each([
    {
      name: "times out when no new chunk arrives before idle timeout",
      expectedError: /stalled/i,
      options: { chunkTimeoutMs: 50 },
    },
    {
      name: "uses a custom idle-timeout error when provided",
      expectedError: "custom idle 50",
      options: {
        chunkTimeoutMs: 50,
        onIdleTimeout: ({ chunkTimeoutMs }: { chunkTimeoutMs: number }) =>
          new Error(`custom idle ${chunkTimeoutMs}`),
      },
    },
  ] as const)(
    "$name",
    async ({ expectedError, options }) => {
      await expectIdleTimeout(() => {
        const body = makeStallingStream([new Uint8Array([1, 2])]);
        const res = new Response(body);
        return readResponseWithLimit(res, 1024, options);
      }, expectedError);
    },
    5_000,
  );

  it("names the default idle timeout for retry classifiers", async () => {
    vi.useFakeTimers();
    try {
      const result = readResponseWithLimit(
        new Response(makeStallingStream([new Uint8Array([1, 2])])),
        1024,
        { chunkTimeoutMs: 50 },
      ).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(60);

      await expect(result).resolves.toMatchObject({
        name: "TimeoutError",
        message: expect.stringMatching(/stalled/i),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out while chunks keep arriving", async () => {
    vi.useFakeTimers();
    try {
      const body = makeStream([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])], 40);
      const res = new Response(body);
      const readPromise = readResponseWithLimit(res, 100, { chunkTimeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(125);
      const buf = await readPromise;
      expect(buf).toEqual(Buffer.from([1, 2, 3]));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps oversized idle timeout timers while reading chunks", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const body = makeStream([new Uint8Array([1]), new Uint8Array([2])]);
      const res = new Response(body);

      const buf = await readResponseWithLimit(res, 100, {
        chunkTimeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
      });

      expect(buf).toEqual(Buffer.from([1, 2]));
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it.each([false, true])(
    "passes the idle-timeout error without waiting for cancellation (%s)",
    async (pendingCancel) => {
      vi.useFakeTimers();
      try {
        const cancel = vi.fn((_reason?: unknown) =>
          pendingCancel ? new Promise<void>(() => {}) : undefined,
        );
        const body = makeStallingStream([new Uint8Array([1, 2])], cancel);
        const res = new Response(body);
        const readPromise = expect(
          readResponseWithLimit(res, 1024, {
            chunkTimeoutMs: 50,
            onIdleTimeout: ({ chunkTimeoutMs }) => new Error(`custom idle ${chunkTimeoutMs}`),
          }),
        ).rejects.toThrow("custom idle 50");

        await vi.advanceTimersByTimeAsync(60);
        await readPromise;
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
        expect((cancel.mock.calls[0]?.[0] as Error | undefined)?.message).toBe("custom idle 50");
        expect(body.locked).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("cancels a trickling body when its overall timeout expires", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const response = new Response(makeTricklingStream(40, cancel));
      const assertion = expect(
        readResponseWithLimit(response, 1024, {
          chunkTimeoutMs: 50,
          timeoutMs: 100,
          onTimeout: ({ timeoutMs }) => new Error(`custom overall ${timeoutMs}`),
        }),
      ).rejects.toThrow("custom overall 100");

      await vi.advanceTimersByTimeAsync(110);
      await assertion;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect((cancel.mock.calls[0]?.[0] as Error | undefined)?.message).toBe("custom overall 100");
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the default overall timeout for retry classifiers", async () => {
    vi.useFakeTimers();
    try {
      const result = readResponseWithLimit(new Response(makeTricklingStream(40)), 1024, {
        timeoutMs: 50,
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(60);

      await expect(result).resolves.toMatchObject({
        name: "TimeoutError",
        message: "Response body timed out after 50ms",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves a lazy overall timeout immediately before reading", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const timeoutMs = vi.fn(() => 75);
      const response = new Response(makeTricklingStream(40, cancel));
      const assertion = expect(
        readResponseWithLimit(response, 1024, {
          timeoutMs,
          onTimeout: ({ timeoutMs: resolved }) => new Error(`lazy overall ${resolved}`),
        }),
      ).rejects.toThrow("lazy overall 75");

      expect(timeoutMs).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(80);
      await assertion;
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the body when a lazy timeout resolver reports an expired deadline", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {});
        },
        cancel,
      }),
    );

    await expect(
      readResponseWithLimit(response, 1024, {
        timeoutMs: () => {
          throw new Error("deadline expired");
        },
      }),
    ).rejects.toThrow("deadline expired");
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ message: "deadline expired" }));
  });

  it("cancels a getReader-less body when its overall timeout expires", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async (_reason?: unknown) => undefined);
      const response = {
        body: { cancel },
        arrayBuffer: async () => await new Promise<ArrayBuffer>(() => {}),
      } as unknown as Response;
      const assertion = expect(
        readResponseWithLimit(response, 1024, {
          timeoutMs: 50,
          onTimeout: ({ timeoutMs }) => new Error(`fallback overall ${timeoutMs}`),
        }),
      ).rejects.toThrow("fallback overall 50");

      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the overall timeout after a successful read", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.close();
        },
        cancel,
      });

      await expect(
        readResponseWithLimit(new Response(body), 100, { timeoutMs: 50 }),
      ).resolves.toEqual(Buffer.from([1, 2]));
      await vi.advanceTimersByTimeAsync(100);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readResponseTextSnippet", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      name: "returns collapsed text within the limit",
      response: new Response(makeStream([new TextEncoder().encode("hello   \n world")])),
      options: { maxBytes: 64, maxChars: 50 },
      expected: "hello world",
    },
    {
      name: "truncates to the byte limit without reading the full body",
      response: new Response(
        makeStream([new TextEncoder().encode("12345"), new TextEncoder().encode("67890")]),
      ),
      options: { maxBytes: 7, maxChars: 50 },
      expected: "1234567…",
    },
    {
      name: "drops partial UTF-8 characters when snippets truncate at a byte boundary",
      response: new Response(makeStream([new TextEncoder().encode("ab😀cd")])),
      options: { maxBytes: 3, maxChars: 50 },
      expected: "ab…",
    },
    {
      name: "keeps character-limited snippets UTF-16 well-formed",
      response: new Response(makeStream([new TextEncoder().encode("ab🚀tail")])),
      options: { maxBytes: 64, maxChars: 3 },
      expected: "ab…",
    },
  ] as const)("$name", async ({ response, options, expected }) => {
    await expect(readResponseTextSnippet(response, options)).resolves.toBe(expected);
  });

  it("rejects invalid maxBytes before reading text snippets", async () => {
    await expect(
      readResponseTextSnippet(new Response(makeStream([new TextEncoder().encode("hello")])), {
        maxBytes: Number.NaN,
      }),
    ).rejects.toThrow(/maxBytes must be a non-negative finite number/);
  });

  it("cancels immediately when a diagnostic prefix fills the byte budget", async () => {
    const cancel = vi.fn();
    const response = new Response(makeStallingStream([new TextEncoder().encode("exact")], cancel));

    await expect(readResponseTextPrefix(response, 5)).resolves.toEqual({
      text: "exact",
      size: 5,
      truncated: true,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { maxBytes: 0.5, text: "", size: 3 },
    { maxBytes: 3.5, text: "abc", size: 6 },
  ])("returns whole bytes under a fractional prefix budget of $maxBytes", async (expected) => {
    const response = new Response(
      makeStream([new TextEncoder().encode("abc"), new TextEncoder().encode("def")]),
    );

    await expect(readResponseTextPrefix(response, expected.maxBytes)).resolves.toEqual({
      text: expected.text,
      size: expected.size,
      truncated: true,
    });
  });

  it("applies the idle timeout while reading snippets", async () => {
    await expectIdleTimeout(() => {
      const res = new Response(makeStallingStream([new Uint8Array([65, 66])]));
      return readResponseTextSnippet(res, { maxBytes: 64, chunkTimeoutMs: 50 });
    });
  }, 5_000);
});
