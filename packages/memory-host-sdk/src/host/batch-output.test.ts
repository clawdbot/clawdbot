import { describe, expect, it } from "vitest";
import { applyEmbeddingBatchOutputLine } from "./batch-output.js";

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
    const remaining = new Set(["req-3", "req-4"]);
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

    expect(errors).toEqual(["req-3: internal", "req-4: empty embedding"]);
    expect(byCustomId.size).toBe(0);
  });
});
