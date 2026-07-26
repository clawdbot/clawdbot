// Memory Host SDK tests cover batch output behavior.
import { describe, expect, it } from "vitest";
import { applyEmbeddingBatchOutputLine, readEmbeddingBatchJsonl } from "./batch-output.js";

function streamingResponse(chunks: Uint8Array[]): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let index = 0;
  let canceled = false;
  return {
    response: new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[index];
          index += 1;
          if (chunk) {
            controller.enqueue(chunk);
            return;
          }
          controller.close();
        },
        cancel() {
          canceled = true;
        },
      }),
    ),
    wasCanceled: () => canceled,
  };
}

describe("readEmbeddingBatchJsonl", () => {
  it("frames split UTF-8, CRLF, and an unterminated final record", async () => {
    const bytes = new TextEncoder().encode('{"value":"😀"}\r\n{"value":2}');
    const streamed = streamingResponse(Array.from(bytes, (byte) => Uint8Array.of(byte)));
    const records: Array<{ value: string | number }> = [];

    await readEmbeddingBatchJsonl<{ value: string | number }>(streamed.response, {
      label: "test.batch-output",
      maxRecords: 2,
      onRecord: (record) => {
        records.push(record);
        return true;
      },
    });

    expect(records).toEqual([{ value: "😀" }, { value: 2 }]);
    expect(streamed.wasCanceled()).toBe(false);
  });

  it("bounds a newline-free record and cancels the stream", async () => {
    const encoder = new TextEncoder();
    const streamed = streamingResponse([
      encoder.encode('{"value":"'),
      encoder.encode("x".repeat(32)),
      encoder.encode('"}\n'),
    ]);

    await expect(
      readEmbeddingBatchJsonl(streamed.response, {
        label: "test.batch-output",
        maxRecords: 1,
        maxRecordBytes: 16,
        onRecord: () => true,
      }),
    ).rejects.toThrow("test.batch-output: JSONL record exceeds 16 bytes");
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("counts blank physical records against the output budget", async () => {
    const streamed = streamingResponse([new TextEncoder().encode("{}\n\n{}\n")]);

    await expect(
      readEmbeddingBatchJsonl(streamed.response, {
        label: "test.batch-output",
        maxRecords: 2,
        onRecord: () => true,
      }),
    ).rejects.toThrow("test.batch-output: JSONL output exceeds 2 records");
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("cancels immediately when the consumer has enough records", async () => {
    const encoder = new TextEncoder();
    const streamed = streamingResponse([encoder.encode('{"value":1}\n'), encoder.encode("{")]);
    const records: unknown[] = [];

    await readEmbeddingBatchJsonl(streamed.response, {
      label: "test.batch-output",
      maxRecords: 2,
      onRecord: (record) => {
        records.push(record);
        return false;
      },
    });

    expect(records).toEqual([{ value: 1 }]);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it.each(["{bad}\n", "null\n", "[]\n"])(
    "cancels after an invalid JSONL record %#",
    async (input) => {
      const malformed = streamingResponse([new TextEncoder().encode(input)]);

      await expect(
        readEmbeddingBatchJsonl(malformed.response, {
          label: "test.batch-output",
          maxRecords: 1,
          onRecord: () => true,
        }),
      ).rejects.toThrow("test.batch-output: malformed JSONL record");
      expect(malformed.wasCanceled()).toBe(true);
    },
  );

  it.each([
    { name: "newline-terminated record", suffix: "\n", canceled: true },
    { name: "unterminated final record", suffix: "", canceled: false },
  ])("rejects malformed UTF-8 in a $name", async ({ canceled, suffix }) => {
    const encoder = new TextEncoder();
    const malformed = streamingResponse([
      new Uint8Array([
        ...encoder.encode('{"value":"'),
        0xc3,
        0x28,
        ...encoder.encode(`"}${suffix}`),
      ]),
    ]);

    await expect(
      readEmbeddingBatchJsonl(malformed.response, {
        label: "test.batch-output",
        maxRecords: 1,
        onRecord: () => true,
      }),
    ).rejects.toThrow("test.batch-output: malformed JSONL record");
    expect(malformed.wasCanceled()).toBe(canceled);
  });

  it("accepts a null response body", async () => {
    await expect(
      readEmbeddingBatchJsonl(new Response(null), {
        label: "test.batch-output",
        maxRecords: 0,
        onRecord: () => true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("applyEmbeddingBatchOutputLine", () => {
  it("stores embedding for successful response", () => {
    const remaining = new Set(["req-1"]);
    const errors: string[] = [];
    const byCustomId = new Map<string, number[]>();

    applyEmbeddingBatchOutputLine({
      line: {
        custom_id: "req-1",
        response: {
          status_code: 200,
          body: { data: [{ embedding: [0.1, 0.2] }] },
        },
      },
      remaining,
      errors,
      byCustomId,
    });

    expect(remaining.has("req-1")).toBe(false);
    expect(errors).toStrictEqual([]);
    expect(byCustomId.get("req-1")).toEqual([0.1, 0.2]);
  });

  it("records provider error from line.error", () => {
    const remaining = new Set(["req-2"]);
    const errors: string[] = [];
    const byCustomId = new Map<string, number[]>();

    applyEmbeddingBatchOutputLine({
      line: {
        custom_id: "req-2",
        error: { message: "provider failed" },
      },
      remaining,
      errors,
      byCustomId,
    });

    expect(remaining.has("req-2")).toBe(false);
    expect(errors).toEqual(["req-2: provider failed"]);
    expect(byCustomId.size).toBe(0);
  });

  it("records non-2xx response errors and empty embedding errors", () => {
    const remaining = new Set(["req-3", "req-4", "req-5"]);
    const errors: string[] = [];
    const byCustomId = new Map<string, number[]>();

    applyEmbeddingBatchOutputLine({
      line: {
        custom_id: "req-3",
        response: {
          status_code: 500,
          body: { error: { message: "internal" } },
        },
      },
      remaining,
      errors,
      byCustomId,
    });

    applyEmbeddingBatchOutputLine({
      line: {
        custom_id: "req-4",
        response: {
          status_code: 200,
          body: { data: [] },
        },
      },
      remaining,
      errors,
      byCustomId,
    });

    applyEmbeddingBatchOutputLine({
      line: {
        custom_id: "req-5",
        response: { status_code: 500, message: "provider response failed", body: "" },
      },
      remaining,
      errors,
      byCustomId,
    });

    expect(errors).toEqual([
      "req-3: internal",
      "req-4: empty embedding",
      "req-5: provider response failed",
    ]);
    expect(byCustomId.size).toBe(0);
  });
});
