// Msteams tests cover shared inbound request deadlines.
import { describe, expect, it, vi } from "vitest";
import {
  resolveMSTeamsSharePointUploadTimeoutMs,
  withMSTeamsRequestDeadline,
} from "./request-timeout.js";

describe("withMSTeamsRequestDeadline", () => {
  it("does not start work after the operation deadline has expired", async () => {
    const work = vi.fn(async () => "late");

    await expect(
      withMSTeamsRequestDeadline({
        deadline: {
          label: "MS Teams inbound preprocessing",
          timeoutMs: 10,
          deadlineAtMs: Date.now() - 1,
        },
        label: "late Teams lookup",
        work,
      }),
    ).rejects.toThrow(/timed out/i);

    expect(work).not.toHaveBeenCalled();
  });
});

describe("resolveMSTeamsSharePointUploadTimeoutMs", () => {
  it("adds transfer budget to the base SharePoint upload deadline", () => {
    const oneHundredMiB = 100 * 1024 * 1024;

    expect(resolveMSTeamsSharePointUploadTimeoutMs(0)).toBe(300_000);
    expect(resolveMSTeamsSharePointUploadTimeoutMs(oneHundredMiB)).toBe(700_000);
  });
});
