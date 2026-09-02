// Job identity normalization tests cover stable ids and names for cron jobs.
import { describe, expect, it } from "vitest";
import { normalizeCronJobIdentityFields } from "./normalize-job-identity.js";

describe("normalizeCronJobIdentityFields", () => {
  it("copies trimmed jobId into id when id is missing", () => {
    const raw: Record<string, unknown> = {
      jobId: "  stable-slug  ",
      name: "n",
    };
    const r = normalizeCronJobIdentityFields(raw);
    expect(r.mutated).toBe(true);
    expect(r.legacyJobIdIssue).toBe(true);
    expect(raw.id).toBe("stable-slug");
    expect(raw.jobId).toBeUndefined();
  });

  it("trims id without reporting a legacy jobId issue when jobId is absent", () => {
    const raw: Record<string, unknown> = {
      id: "  trimmed-id  ",
      name: "n",
    };
    const r = normalizeCronJobIdentityFields(raw);
    expect(r.mutated).toBe(true);
    expect(r.legacyJobIdIssue).toBe(false);
    expect(raw.id).toBe("trimmed-id");
  });

  it("removes redundant jobId while keeping canonical id", () => {
    const raw: Record<string, unknown> = {
      id: "keep-me",
      jobId: "keep-me",
      name: "n",
    };
    const r = normalizeCronJobIdentityFields(raw);
    expect(r.mutated).toBe(true);
    expect(r.legacyJobIdIssue).toBe(true);
    expect(raw.id).toBe("keep-me");
    expect(raw.jobId).toBeUndefined();
  });

  it("ignores non-string jobId", () => {
    const raw: Record<string, unknown> = {
      id: "x",
      jobId: 1,
      name: "n",
    };
    const r = normalizeCronJobIdentityFields(raw);
    expect(r.mutated).toBe(true);
    expect(r.legacyJobIdIssue).toBe(true);
    expect(raw.id).toBe("x");
    expect(raw.jobId).toBeUndefined();
  });
});
