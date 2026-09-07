import { describe, expect, it } from "vitest";
import { redactModelVisibleSecrets, redactSecrets } from "./redact.js";

describe.each([redactSecrets, redactModelVisibleSecrets])("%s structured properties", (redact) => {
  it("redacts public share capabilities without treating ordinary ids as secrets", () => {
    const shareId = "a".repeat(48);
    expect(
      redact({
        publicShare: { id: shareId, sessionId: "session-1", createdAt: 1 },
        ordinary: { id: shareId },
      }),
    ).toEqual({
      publicShare: { id: "aaaaaa…aaaa", sessionId: "session-1", createdAt: 1 },
      ordinary: { id: shareId },
    });
  });

  it("preserves JSON prototype-named fields as redacted own data", () => {
    const input = JSON.parse(
      '{"__proto__":{"label":"root","token":"fixture-value"},"nested":{"__proto__":null},"items":[{"__proto__":"ordinary"},{"__proto__":123}]}',
    );
    const before = JSON.stringify(input);
    const result = redact(input);

    expect(JSON.stringify(result)).toBe(
      '{"__proto__":{"label":"root","token":"***"},"nested":{"__proto__":null},"items":[{"__proto__":"ordinary"},{"__proto__":123}]}',
    );
    for (const value of [result, result.nested, ...result.items]) {
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(Object.hasOwn(value, "__proto__")).toBe(true);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("keeps shared references distinct from cycles and preserves nonplain values", () => {
    const shared = { label: "ordinary", token: "fixture-value" };
    const input: Record<string, unknown> = Object.assign(Object.create(null), {
      first: shared,
      second: shared,
      date: new Date(0),
    });
    input.self = input;
    const result = redact(input);

    expect(result).toEqual({
      first: { label: "ordinary", token: "***" },
      second: { label: "ordinary", token: "***" },
      date: input.date,
      self: "[Circular]",
    });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.date).toBe(input.date);
    expect(result.first).not.toBe(shared);
    expect(shared.token).toBe("fixture-value");
  });
});
