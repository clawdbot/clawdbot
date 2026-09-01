import { describe, expect, it } from "vitest";
import { assertTriggerSupport } from "./jobs-validation.js";

const triggerJob = {
  schedule: { kind: "every" as const, everyMs: 30_000 },
  trigger: { script: "json({ fire: true })" },
};

describe("cron trigger enablement", () => {
  it("allows triggers by default when cron.triggers is omitted", () => {
    expect(() =>
      assertTriggerSupport(triggerJob, {
        cronConfig: {},
        validateAuthoredTrigger: true,
      }),
    ).not.toThrow();
  });

  it("rejects triggers when the operator explicitly opts out", () => {
    expect(() =>
      assertTriggerSupport(triggerJob, {
        cronConfig: { triggers: { enabled: false } },
        validateAuthoredTrigger: true,
      }),
    ).toThrow(
      "cron triggers are disabled because the operator set cron.triggers.enabled: false; remove it or set it to true",
    );
  });
});
