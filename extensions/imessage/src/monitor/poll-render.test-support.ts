// Imessage test support covers poll rendering.
import { describe, expect, it } from "vitest";
import { renderIMessagePollBody } from "./poll-render.js";

describe("renderIMessagePollBody", () => {
  it("renders a created poll with numbered options", () => {
    const out = renderIMessagePollBody({
      kind: "created",
      question: "Favorite color?",
      options: [
        { id: "a", text: "Red" },
        { id: "b", text: "Blue" },
      ],
    });
    expect(out).toContain("Favorite color?");
    expect(out).toContain("1) Red");
    expect(out).toContain("2) Blue");
    // Must cue the vote action so the agent votes instead of replying in prose;
    // the 📊 Poll prefix matches agents' vote-instruction trigger.
    expect(out).toContain("poll-vote");
    expect(out).toContain("\u{1F4CA} Poll");
  });

  it("folds in vote tallies", () => {
    const out = renderIMessagePollBody({
      kind: "created",
      options: [
        { id: "a", text: "Red" },
        { id: "b", text: "Blue" },
      ],
      votes: [
        { option_id: "b", event_type: "selected" },
        { option_id: "b", event_type: "selected" },
        { option_id: "a", event_type: "removed" },
      ],
    });
    expect(out).toContain("2) Blue [2]");
    // Removed votes and unvoted options carry no tally suffix.
    expect(out).toContain("1) Red");
    expect(out).not.toContain("Red [");
  });

  it("renders a vote update", () => {
    const out = renderIMessagePollBody({
      kind: "vote",
      vote: { participant: "+12065550123", option_text: "Blue", event_type: "selected" },
    });
    expect(out).toContain("Poll vote");
    expect(out).toContain("Blue");
  });

  it("returns null for a poll with no options and no vote", () => {
    expect(renderIMessagePollBody({ kind: "created", options: [] })).toBeNull();
  });
});
