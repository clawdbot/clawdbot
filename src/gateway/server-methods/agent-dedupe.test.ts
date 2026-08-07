import { describe, expect, it } from "vitest";
import { isPreRegistrationAbortedAgentDedupeEntryForSession } from "./agent-dedupe.js";

describe("agent dedupe", () => {
  it("compares admitted run identities without normalizing them", () => {
    const entry = {
      ts: 1,
      ok: true,
      payload: {
        runId: " padded-agent-run ",
        status: "timeout",
        stopReason: "rpc",
      },
    } as const;

    expect(
      isPreRegistrationAbortedAgentDedupeEntryForSession({
        entry,
        runId: " padded-agent-run ",
      }),
    ).toBe(true);
    expect(
      isPreRegistrationAbortedAgentDedupeEntryForSession({
        entry,
        runId: "padded-agent-run",
      }),
    ).toBe(false);
  });
});
