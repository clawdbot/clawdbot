import { describe, expect, it } from "vitest";
import { projectDiagnosticPayload } from "./payload-redaction.js";

describe("projectDiagnosticPayload", () => {
  it("bounds hostile depth without recursive traversal", () => {
    const input: Record<string, unknown> = {};
    let cursor = input;
    for (let index = 0; index < 20_000; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    const projected = projectDiagnosticPayload(input, {
      limits: {
        maxArrayItems: 64,
        maxDepth: 6,
        maxObjectKeys: 64,
        maxStringChars: 32_768,
      },
    }) as Record<string, unknown>;

    let bounded: unknown = projected;
    for (let depth = 0; depth < 6; depth += 1) {
      bounded = (bounded as Record<string, unknown>).next;
    }
    expect(bounded).toEqual({
      truncated: true,
      reason: "depth",
      limitDepth: 6,
    });
  });

  it("resolves transformed key collisions deterministically without mutating input", () => {
    const input = { first: 1, second: 2, third: 3 };
    const original = structuredClone(input);

    expect(
      projectDiagnosticPayload(input, {
        transformKey: () => "same",
      }),
    ).toEqual({
      same: 1,
      "same#2": 2,
      "same#3": 3,
    });
    expect(input).toEqual(original);
  });
});
