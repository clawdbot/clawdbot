import { describe, expect, it } from "vitest";
import { normalizeCronRuntimeAuthority } from "./runtime-authority.js";

function authority(payload: unknown) {
  return {
    version: 1,
    runtimeId: "codex",
    namespace: "codex.apps",
    payload,
  };
}

describe("normalizeCronRuntimeAuthority", () => {
  it("normalizes and deeply freezes a bounded JSON authority envelope", () => {
    const input = authority({ apps: [{ id: "calendar", enabled: true }] });

    const normalized = normalizeCronRuntimeAuthority(input);

    if (!normalized) {
      throw new Error("expected normalized runtime authority");
    }
    expect(normalized).toEqual(input);
    expect(normalized).not.toBe(input);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.payload)).toBe(true);
    expect(Object.isFrozen((normalized.payload.apps as unknown[])[0])).toBe(true);
  });

  it.each([
    authority({ value: Number.NaN }),
    authority({ value: Number.POSITIVE_INFINITY }),
    authority({ value: undefined }),
    authority({ value: 1n }),
    authority({ value: new Date() }),
    { ...authority({}), extra: true },
    { ...authority({}), runtimeId: "Codex" },
    { ...authority({}), namespace: "codex apps" },
  ])("rejects non-JSON or non-canonical envelopes", (input) => {
    expect(normalizeCronRuntimeAuthority(input)).toBeUndefined();
  });

  it("rejects cyclic and excessively deep payloads", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 18; index += 1) {
      deep = { child: deep };
    }

    expect(normalizeCronRuntimeAuthority(authority(cyclic))).toBeUndefined();
    expect(normalizeCronRuntimeAuthority(authority(deep))).toBeUndefined();
  });

  it("preserves hostile JSON keys as inert data", () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;

    const normalized = normalizeCronRuntimeAuthority(authority(payload));

    expect(Object.getPrototypeOf(normalized?.payload)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(normalized?.payload, "__proto__")?.value).toEqual({
      polluted: true,
    });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("rejects the complete envelope above 64 KiB", () => {
    expect(
      normalizeCronRuntimeAuthority(authority({ data: "x".repeat(64 * 1024) })),
    ).toBeUndefined();
  });
});
