import { describe, expect, it, vi } from "vitest";
import { safeEqualSecret } from "./secret-equal.js";

const { timingSafeEqualSpy } = vi.hoisted(() => ({
  timingSafeEqualSpy: vi.fn(),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual);
  return { ...actual, timingSafeEqual: timingSafeEqualSpy };
});

describe("safeEqualSecret", () => {
  it.each([
    ["secret-token", "secret-token", true],
    ["secret-token", "secret-tokEn", false],
    ["short", "much-longer", false],
    ["", "", true],
    ["", "secret", false],
    [undefined, "secret", false],
    [null, "secret", false],
  ] as const)("compares %o and %o", (left, right, expected) => {
    expect(safeEqualSecret(left, right)).toBe(expected);
  });

  it("compares Unicode by exact UTF-8 bytes without normalization", () => {
    expect(safeEqualSecret("é", "e\u0301")).toBe(false);
  });

  it("pads unequal UTF-8 lengths but still rejects original length mismatches", () => {
    timingSafeEqualSpy.mockClear();
    expect(safeEqualSecret("é", "much-longer-秘密")).toBe(false);
    const [providedBytes, expectedBytes] = timingSafeEqualSpy.mock.calls[0] ?? [];
    expect(providedBytes).toHaveLength(expectedBytes?.byteLength ?? 0);

    timingSafeEqualSpy.mockClear();
    expect(safeEqualSecret("a", "a\0")).toBe(false);
    expect(timingSafeEqualSpy).toHaveReturnedWith(true);
  });
});
