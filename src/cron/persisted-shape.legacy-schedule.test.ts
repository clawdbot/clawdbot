import { describe, expect, it } from "vitest";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";
import { assertCronStoreCanPersist } from "./store/row-codec.js";
import type { CronStoreFile } from "./types.js";

// Legacy cron JSON files (imported by `openclaw doctor --fix`) can carry a
// shorthand string schedule. Those rows still have to be validated like any
// other persisted row, or a broken one reaches the SQLite binder.
function legacyShorthandJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "legacy-1",
    name: "legacy",
    schedule: "*/5 * * * *",
    ...overrides,
  };
}

describe("persisted cron shape with a legacy shorthand schedule", () => {
  it("rejects a payload-less legacy row", () => {
    expect(getInvalidPersistedCronJobReason(legacyShorthandJob())).toBe("missing-payload");
  });

  it("rejects an unloadable payload on a legacy row", () => {
    expect(
      getInvalidPersistedCronJobReason(legacyShorthandJob({ payload: { kind: "agentTurn" } })),
    ).toBe("invalid-payload");
  });

  it("still accepts a legacy row whose payload is loadable", () => {
    expect(
      getInvalidPersistedCronJobReason(
        legacyShorthandJob({ payload: { kind: "systemEvent", text: "hi" } }),
      ),
    ).toBeNull();
  });

  it("counts a payload-less legacy row as unpersistable instead of throwing on the binder", () => {
    const store = {
      version: 1,
      jobs: [legacyShorthandJob()],
    } as unknown as CronStoreFile;
    expect(() => assertCronStoreCanPersist(store)).toThrow(
      "Cannot persist cron store with 1 invalid job(s)",
    );
  });
});
