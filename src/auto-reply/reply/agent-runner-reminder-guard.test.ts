import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import {
  appendUnscheduledReminderNote,
  hasUnbackedReminderCommitment,
} from "./agent-runner-reminder-guard.js";

describe("hasUnbackedReminderCommitment", () => {
  it("matches temporal reminder commitments without flagging plain memory statements", () => {
    expect(hasUnbackedReminderCommitment("I'll remind you tomorrow.")).toBe(true);
    expect(hasUnbackedReminderCommitment("I'll remember to check on that tomorrow.")).toBe(true);
    expect(hasUnbackedReminderCommitment("I'll remember and remind you tomorrow.")).toBe(true);
    expect(hasUnbackedReminderCommitment("I will remember, then follow up next week.")).toBe(true);
    expect(hasUnbackedReminderCommitment("I'll remember that and remind you tomorrow.")).toBe(true);
    expect(hasUnbackedReminderCommitment("I'll remember that and will remind you tomorrow.")).toBe(
      true,
    );
    expect(hasUnbackedReminderCommitment("I'll remember this, then follow up next week.")).toBe(
      true,
    );
    expect(hasUnbackedReminderCommitment("I'll remember that preference.")).toBe(false);
    expect(hasUnbackedReminderCommitment("I'll remember the specifics.")).toBe(false);
    expect(hasUnbackedReminderCommitment("I'll remember to use metric units for you.")).toBe(false);
    expect(
      hasUnbackedReminderCommitment(
        "I'll remember to use metric units when answering distance questions.",
      ),
    ).toBe(false);
  });
});

describe("appendUnscheduledReminderNote", () => {
  it("preserves transcript ownership metadata when appending the guard note", () => {
    const payload = setReplyPayloadMetadata(
      { text: "I'll remind you tomorrow." },
      { assistantTranscriptOwned: true },
    );

    const [guarded] = appendUnscheduledReminderNote([payload]);

    expect(guarded?.text).toContain("I did not schedule a reminder");
    expect(getReplyPayloadMetadata(guarded ?? {})).toEqual({
      assistantTranscriptOwned: true,
    });
  });
});
