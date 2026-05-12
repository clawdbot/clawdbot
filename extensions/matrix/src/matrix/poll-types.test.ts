import { describe, expect, it } from "vitest";
import {
  buildPollResultsSummary,
  buildPollResponseContent,
  buildPollStartContent,
  formatPollResultsAsText,
  parsePollStart,
  parsePollResponseAnswerIds,
  parsePollStartContent,
  resolvePollReferenceEventId,
} from "./poll-types.js";

describe("parsePollStartContent", () => {
  it("parses legacy m.poll payloads", () => {
    const summary = parsePollStartContent({
      "m.poll": {
        question: { "m.text": "Lunch?" },
        kind: "m.poll.disclosed",
        max_selections: 1,
        answers: [
          { id: "answer1", "m.text": "Yes" },
          { id: "answer2", "m.text": "No" },
        ],
      },
    });

    expect(summary?.question).toBe("Lunch?");
    expect(summary?.answers).toEqual(["Yes", "No"]);
  });

  it("preserves answer ids when parsing poll start content", () => {
    const parsed = parsePollStart({
      "m.poll.start": {
        question: { "m.text": "Lunch?" },
        kind: "m.poll.disclosed",
        max_selections: 1,
        answers: [
          { id: "a1", "m.text": "Yes" },
          { id: "a2", "m.text": "No" },
        ],
      },
    });

    expect(parsed).toEqual({
      question: "Lunch?",
      answers: [
        { id: "a1", text: "Yes" },
        { id: "a2", text: "No" },
      ],
      kind: "m.poll.disclosed",
      maxSelections: 1,
    });
  });

  it("caps invalid remote max selections to the available answer count", () => {
    const parsed = parsePollStart({
      "m.poll.start": {
        question: { "m.text": "Lunch?" },
        kind: "m.poll.undisclosed",
        max_selections: 99,
        answers: [
          { id: "a1", "m.text": "Yes" },
          { id: "a2", "m.text": "No" },
        ],
      },
    });

    expect(parsed?.maxSelections).toBe(2);
  });
});

describe("buildPollStartContent", () => {
  it("preserves the requested multiselect cap instead of widening to all answers", () => {
    const content = buildPollStartContent({
      question: "Lunch?",
      options: ["Pizza", "Sushi", "Tacos"],
      maxSelections: 2,
    });

    expect(content["m.poll.start"]?.max_selections).toBe(2);
    expect(content["m.poll.start"]?.kind).toBe("m.poll.undisclosed");
  });
});

describe("buildPollResponseContent", () => {
  it("builds a poll response payload with a reference relation", () => {
    expect(buildPollResponseContent("$poll", ["a2"])).toEqual({
      "m.poll.response": {
        answers: ["a2"],
      },
      "org.matrix.msc3381.poll.response": {
        answers: ["a2"],
      },
      "m.relates_to": {
        rel_type: "m.reference",
        event_id: "$poll",
      },
    });
  });
});

describe("poll relation parsing", () => {
  it("parses stable and unstable poll response answer ids", () => {
    expect(
      parsePollResponseAnswerIds({
        "m.poll.response": { answers: ["a1"] },
        "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
      }),
    ).toEqual(["a1"]);
    expect(
      parsePollResponseAnswerIds({
        "org.matrix.msc3381.poll.response": { answers: ["a2"] },
      }),
    ).toEqual(["a2"]);
  });

  it("extracts poll relation targets", () => {
    expect(
      resolvePollReferenceEventId({
        "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
      }),
    ).toBe("$poll");
  });
});

describe("buildPollResultsSummary", () => {
  it("counts only the latest valid response from each sender", () => {
    const summary = buildPollResultsSummary({
      pollEventId: "$poll",
      roomId: "!room:example.org",
      sender: "@alice:example.org",
      senderName: "Alice",
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          kind: "m.poll.disclosed",
          max_selections: 1,
          answers: [
            { id: "a1", "m.text": "Pizza" },
            { id: "a2", "m.text": "Sushi" },
          ],
        },
      },
      relationEvents: [
        {
          event_id: "$vote1",
          sender: "@bob:example.org",
          type: "m.poll.response",
          origin_server_ts: 1,
          content: {
            "m.poll.response": { answers: ["a1"] },
            "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
          },
        },
        {
          event_id: "$vote2",
          sender: "@bob:example.org",
          type: "m.poll.response",
          origin_server_ts: 2,
          content: {
            "m.poll.response": { answers: ["a2"] },
            "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
          },
        },
        {
          event_id: "$vote3",
          sender: "@carol:example.org",
          type: "m.poll.response",
          origin_server_ts: 3,
          content: {
            "m.poll.response": { answers: [] },
            "m.relates_to": { rel_type: "m.reference", event_id: "$poll" },
          },
        },
      ],
    });

    expect(summary?.entries).toEqual([
      { id: "a1", text: "Pizza", votes: 0 },
      { id: "a2", text: "Sushi", votes: 1 },
    ]);
    expect(summary?.totalVotes).toBe(1);
  });

  it("formats disclosed poll results with vote totals", () => {
    const text = formatPollResultsAsText({
      eventId: "$poll",
      roomId: "!room:example.org",
      sender: "@alice:example.org",
      senderName: "Alice",
      question: "Lunch?",
      answers: ["Pizza", "Sushi"],
      kind: "m.poll.disclosed",
      maxSelections: 1,
      entries: [
        { id: "a1", text: "Pizza", votes: 1 },
        { id: "a2", text: "Sushi", votes: 0 },
      ],
      totalVotes: 1,
      closed: false,
    });

    expect(text).toContain("1. Pizza (1 vote)");
    expect(text).toContain("Total voters: 1");
  });
});
