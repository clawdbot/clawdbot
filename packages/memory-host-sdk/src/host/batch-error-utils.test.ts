// Memory Host SDK tests cover batch error utils behavior.
import { describe, expect, it } from "vitest";
import {
  EmbeddingBatchUnavailableError,
  extractBatchErrorMessage,
  formatBatchErrorDetail,
  formatUnavailableBatchError,
  isEmbeddingBatchUnavailableError,
} from "../engine-embeddings.js";

describe("extractBatchErrorMessage", () => {
  it("returns the first top-level error message", () => {
    expect(
      extractBatchErrorMessage([
        { response: { body: { error: { message: "nested" } } } },
        { error: { message: "top-level" } },
      ]),
    ).toBe("nested");
  });

  it("falls back to nested response error message", () => {
    expect(
      extractBatchErrorMessage([{ response: { body: { error: { message: "nested-only" } } } }, {}]),
    ).toBe("nested-only");
  });

  it("accepts plain string response bodies", () => {
    expect(extractBatchErrorMessage([{ response: { body: "provider plain-text error" } }])).toBe(
      "provider plain-text error",
    );
    expect(
      extractBatchErrorMessage([{ response: { body: "", message: "response fallback" } }]),
    ).toBe("response fallback");
  });

  it("accepts Voyage response messages", () => {
    expect(
      extractBatchErrorMessage([
        { response: { status_code: 500, message: "Internal Server Error" }, error: null },
      ]),
    ).toBe("Internal Server Error");
    expect(
      extractBatchErrorMessage([
        { response: { status_code: 500, message: "nested fallback" }, error: { message: "" } },
      ]),
    ).toBe("nested fallback");
  });
});

describe("EmbeddingBatchUnavailableError", () => {
  it("survives duplicate module instances through its stable code", () => {
    const error = new EmbeddingBatchUnavailableError("not available", {
      cause: new Error("provider detail"),
    });

    expect(error).toMatchObject({
      name: "EmbeddingBatchUnavailableError",
      code: "embedding_batch_unavailable",
      message: "not available",
    });
    expect(error.cause).toBeInstanceOf(Error);
    expect(isEmbeddingBatchUnavailableError(error)).toBe(true);
    expect(isEmbeddingBatchUnavailableError({ code: "embedding_batch_unavailable" })).toBe(true);
    expect(isEmbeddingBatchUnavailableError(new Error("other"))).toBe(false);
  });
});

describe("formatBatchErrorDetail", () => {
  it("preserves short details and redacts and bounds long provider text", () => {
    expect(formatBatchErrorDetail("short detail")).toBe("short detail");

    const secret = `sk-${"a".repeat(24)}`;
    const formatted = formatBatchErrorDetail(`API_TOKEN=${secret} ${"😀".repeat(400)}`);

    expect(formatted).toMatch(/\.\.\. \[truncated\]$/);
    expect(formatted?.length).toBeLessThanOrEqual(500);
    expect(formatted).not.toContain(secret);
    expect(formatted).not.toMatch(/[\uD800-\uDFFF]/u);
  });
});

describe("formatUnavailableBatchError", () => {
  it("formats errors and non-error values", () => {
    expect(formatUnavailableBatchError(new Error("boom"))).toBe("error file unavailable: boom");
    expect(formatUnavailableBatchError("unreachable")).toBe("error file unavailable: unreachable");
  });

  it("redacts exported tokens without malformed UTF-16", () => {
    const secret = `abcd😀${"x".repeat(18)}😀ab`;
    const serialized = JSON.stringify({
      error: formatUnavailableBatchError(new Error(`API_TOKEN=${secret}`)),
    });
    const parsed = JSON.parse(serialized) as { error: string };

    expect(parsed.error).toBe("error file unavailable: API_TOKEN=***");
    expect(parsed.error).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(serialized).not.toContain(secret);
  });
});
