// Line tests cover monthly message quota reads and the refusal they explain.
import { describe, expect, it, vi } from "vitest";
import {
  describeLineQuotaRefusal,
  isLineMessageQuotaExhausted,
  readLineMessageQuota,
  type LineMessageQuotaReader,
} from "./message-quota.js";

function createReader(
  getMessageQuota: LineMessageQuotaReader["getMessageQuota"],
  getMessageQuotaConsumption: LineMessageQuotaReader["getMessageQuotaConsumption"] = async () => ({
    totalUsage: 0,
  }),
) {
  const reader = {
    getMessageQuota: vi.fn(getMessageQuota),
    getMessageQuotaConsumption: vi.fn(getMessageQuotaConsumption),
  };
  return { reader, ...reader };
}

describe("readLineMessageQuota", () => {
  it("reports the allowance an account has spent", async () => {
    const { reader } = createReader(
      async () => ({ type: "limited", value: 200 }),
      async () => ({ totalUsage: 70 }),
    );

    await expect(readLineMessageQuota(reader)).resolves.toEqual({
      kind: "limited",
      limit: 200,
      used: 70,
    });
  });

  it("reports a plan without a limit without reading consumption", async () => {
    const { reader, getMessageQuotaConsumption } = createReader(async () => ({ type: "none" }));

    await expect(readLineMessageQuota(reader)).resolves.toEqual({ kind: "unlimited" });
    expect(getMessageQuotaConsumption).not.toHaveBeenCalled();
  });

  it("reads as unknown when LINE cannot answer, so callers keep their own verdict", async () => {
    const { reader } = createReader(async () => {
      throw new Error("401 - Unauthorized");
    });

    await expect(readLineMessageQuota(reader)).resolves.toBeUndefined();
  });
});

describe("isLineMessageQuotaExhausted", () => {
  it.each([
    { quota: { kind: "limited", limit: 200, used: 200 } as const, exhausted: true },
    { quota: { kind: "limited", limit: 200, used: 201 } as const, exhausted: true },
    { quota: { kind: "limited", limit: 200, used: 199 } as const, exhausted: false },
    { quota: { kind: "unlimited" } as const, exhausted: false },
  ])("reports $quota.kind as exhausted=$exhausted", ({ quota, exhausted }) => {
    expect(isLineMessageQuotaExhausted(quota)).toBe(exhausted);
  });
});

describe("describeLineQuotaRefusal", () => {
  it("names the spent allowance so an operator can act on it", () => {
    expect(describeLineQuotaRefusal({ kind: "limited", limit: 200, used: 200 })).toContain(
      "200/200 monthly messages used",
    );
  });

  it.each([
    { label: "an allowance with room", quota: { kind: "limited", limit: 200, used: 5 } as const },
    { label: "a plan without a limit", quota: { kind: "unlimited" } as const },
    { label: "an unreadable allowance", quota: undefined },
  ])("stays silent for $label", ({ quota }) => {
    expect(describeLineQuotaRefusal(quota)).toBeUndefined();
  });
});
