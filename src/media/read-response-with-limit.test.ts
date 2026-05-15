import { beforeEach, describe, expect, it, vi } from "vitest";
import { readResponseTextSnippet, readResponseWithLimit } from "./read-response-with-limit.js";

function makeStream(chunks: Uint8Array[], delayMs?: number) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function makeStallingStream(initialChunks: Uint8Array[], onCancel?: (reason?: unknown) => void) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of initialChunks) {
        controller.enqueue(chunk);
      }
    },
    cancel: onCancel,
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

async function expectReadResponseTextSnippetCase(params: {
  response: Response;
  options: Parameters<typeof readResponseTextSnippet>[1];
  expected: string;
}) {
  await expect(readResponseTextSnippet(params.response, params.options)).resolves.toBe(
    params.expected,
  );
}

async function expectReadResponseWithLimitSuccessCase(params: {
  response: Response;
  maxBytes: number;
  expected: Buffer;
  options?: Parameters<typeof readResponseWithLimit>[2];
}) {
  const buf = await readResponseWithLimit(params.response, params.maxBytes, params.options);
  expect(buf).toEqual(params.expected);
}

async function expectReadResponseWithLimitFailureCase(params: {
  response: Response;
  maxBytes: number;
  options?: Parameters<typeof readResponseWithLimit>[2];
  expectedError: RegExp | string;
}) {
  await expect(
    readResponseWithLimit(params.response, params.maxBytes, params.options),
  ).rejects.toThrow(params.expectedError);
}

describe("readResponseWithLimit", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      name: "reads all chunks within the limit",
      response: new Response(makeStream([new Uint8Array([1, 2]), new Uint8Array([3, 4])])),
      maxBytes: 100,
      expected: Buffer.from([1, 2, 3, 4]),
    },
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
  ] as const)("$name", async ({ response, maxBytes, options, expected, expectedError }) => {
    if (expected !== undefined) {
      await expectReadResponseWithLimitSuccessCase({ response, maxBytes, options, expected });
      return;
    }

    await expectReadResponseWithLimitFailureCase({
      response,
      maxBytes,
      options,
      expectedError,
    });
  });

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

  it.each([
    {
      name: "does not time out while chunks keep arriving",
      expected: Buffer.from([1, 2]),
    },
  ] as const)("$name", async ({ expected }) => {
    vi.useFakeTimers();
    try {
      const body = makeStream([new Uint8Array([1]), new Uint8Array([2])], 10);
      const res = new Response(body);
      const readPromise = readResponseWithLimit(res, 100, { chunkTimeoutMs: 500 });
      await vi.advanceTimersByTimeAsync(25);
      const buf = await readPromise;
      expect(buf).toEqual(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the idle-timeout error to stream cancellation", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
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
  ] as const)("$name", async ({ response, options, expected }) => {
    await expectReadResponseTextSnippetCase({ response, options, expected });
  });

  it.each([
    {
      name: "applies the idle timeout while reading snippets",
      createReadPromise: () => {
        const res = new Response(makeStallingStream([new Uint8Array([65, 66])]));
        return readResponseTextSnippet(res, { maxBytes: 64, chunkTimeoutMs: 50 });
      },
    },
  ] as const)(
    "$name",
    async ({ createReadPromise }) => {
      await expectIdleTimeout(createReadPromise);
    },
    5_000,
  );
});
