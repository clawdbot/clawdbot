import { describe, expect, it } from "vitest";
import { assertPrecheckSupport, assertTriggerSupport } from "./jobs-validation.js";

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

const precheckJob = {
  precheck: { kind: "exec" as const, command: "exit 0" },
};

describe("cron precheck enablement", () => {
  it("allows precheck by default when cron.triggers is omitted", () => {
    expect(() =>
      assertPrecheckSupport(precheckJob, {
        cronConfig: {},
        requireEnabled: true,
      }),
    ).not.toThrow();
  });

  it("rejects precheck when the operator explicitly opts out", () => {
    expect(() =>
      assertPrecheckSupport(precheckJob, {
        cronConfig: { triggers: { enabled: false } },
        requireEnabled: true,
      }),
    ).toThrow(/cron precheck is a host-shell command and is disabled/);
  });
});
