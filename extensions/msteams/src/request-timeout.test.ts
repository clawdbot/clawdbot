// Msteams tests cover shared inbound request deadlines.
import { describe, expect, it, vi } from "vitest";
import { withMSTeamsRequestDeadline } from "./request-timeout.js";

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
