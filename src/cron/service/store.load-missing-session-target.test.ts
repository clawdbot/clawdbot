import { describe, expect, it } from "vitest";
import { assertSupportedJobSpec } from "./jobs.js";

describe("cron service store load: missing sessionTarget", () => {
  it("assertSupportedJobSpec throws a clear error when sessionTarget is missing", () => {
    const bogus = {
      payload: { kind: "agentTurn" as const, message: "ping" },
    } as unknown as Parameters<typeof assertSupportedJobSpec>[0];

    expect(() => assertSupportedJobSpec(bogus)).toThrow(/missing sessionTarget/);
  });
});
