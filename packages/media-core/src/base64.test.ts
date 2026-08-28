// Media Core tests cover base64 behavior.
import { describe, expect, it } from "vitest";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "./base64.js";

describe("base64 helpers", () => {
  function expectBase64HelperCase<T>(actual: T, expected: T) {
    expect(actual).toBe(expected);
  }

  it("canonicalizeBase64 validates large payloads without cons-string overflow", () => {
    const encoded = Buffer.alloc(1_900_000).toString("base64");

    expect(canonicalizeBase64(encoded)).toBe(encoded);
  });

  it("canonicalizeBase64 handles attachment-sized payloads without heap blow-up", () => {
    // Regression guard: the previous per-character append built one cons-string
    // node per input character (~25 bytes each, all live at once), so this
    // 16 MiB payload (21.3 M base64 chars) transiently needed >500 MB of heap.
    // The threshold is deliberately generous; the bounded-buffer implementation
    // returns already-canonical input unchanged.
    const encoded = Buffer.alloc(16 * 1024 * 1024, 0xab).toString("base64");
    const before = process.memoryUsage().heapUsed;

    expect(canonicalizeBase64(encoded)).toBe(encoded);

    const delta = process.memoryUsage().heapUsed - before;
    expect(delta).toBeLessThan(100 * 1024 * 1024);
  });

  it("canonicalizeBase64 cleans whitespace inside large payloads", () => {
    const encoded = Buffer.alloc(1_000_000, 0xab).toString("base64");
    const wrapped = encoded.replace(/(.{76})/g, "$1\r\n");

    expect(canonicalizeBase64(wrapped)).toBe(encoded);
  });

  it("canonicalizeBase64 handles one whitespace per character without heap blow-up", () => {
    // Worst case for any run-collecting cleanup strategy: every data character
    // is its own whitespace-delimited run (2.7 M runs here). The whole cleanup
    // must stay bounded by the input length — one output buffer — not by the
    // number of runs.
    const encoded = Buffer.alloc(2 * 1024 * 1024, 0xab).toString("base64");
    const shredded = encoded.split("").join("\n");
    // heapUsed catches per-run JS objects (slices, rope nodes); arrayBuffers
    // catches Buffer-backed strategies — bound both.
    const usedBytes = () => {
      const usage = process.memoryUsage();
      return usage.heapUsed + usage.arrayBuffers;
    };
    const before = usedBytes();

    expect(canonicalizeBase64(shredded)).toBe(encoded);

    const delta = usedBytes() - before;
    expect(delta).toBeLessThan(64 * 1024 * 1024);
  });

  it.each([
    {
      name: "canonicalizeBase64 normalizes whitespace and keeps valid base64",
      actual: canonicalizeBase64(" SGV s bG8= \n"),
      expected: "SGVsbG8=",
    },
    {
      name: "canonicalizeBase64 pads valid unpadded base64",
      actual: canonicalizeBase64("SGVsbG8"),
      expected: "SGVsbG8=",
    },
    {
      name: "canonicalizeBase64 rejects impossible unpadded length",
      actual: canonicalizeBase64("S"),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 rejects invalid base64 characters",
      actual: canonicalizeBase64('SGVsbG8=" onerror="alert(1)'),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 rejects nonzero pad bits",
      actual: canonicalizeBase64("ZE=="),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 rejects nonzero pad bits on auto-padded input",
      actual: canonicalizeBase64("ZE"),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 trims leading and trailing whitespace",
      actual: canonicalizeBase64("\n\tSGVsbG8=  "),
      expected: "SGVsbG8=",
    },
    {
      name: "canonicalizeBase64 rejects data chars after padding",
      actual: canonicalizeBase64("QQ==QQ=="),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 rejects more than two padding chars",
      actual: canonicalizeBase64("===="),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 rejects a data: URL prefix",
      actual: canonicalizeBase64("data:image/png;base64,QUJD"),
      expected: undefined,
    },
    {
      name: "canonicalizeBase64 rejects whitespace-only input",
      actual: canonicalizeBase64(" \r\n\t"),
      expected: undefined,
    },
    {
      name: "estimateBase64DecodedBytes handles whitespace",
      actual: estimateBase64DecodedBytes("SGV s bG8= \n"),
      expected: 5,
    },
    {
      name: "estimateBase64DecodedBytes handles empty input",
      actual: estimateBase64DecodedBytes(""),
      expected: 0,
    },
  ] as const)("$name", ({ actual, expected }) => {
    expectBase64HelperCase(actual, expected);
  });
});
