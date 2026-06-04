// Tests poll parameter parsing and numeric bounds.
import { describe, expect, it } from "vitest";
import { hasPollCreationParams } from "./poll-params.js";

describe("poll params", () => {
  it("does not treat explicit false booleans as poll creation params", () => {
    expect(
      hasPollCreationParams({
        pollMulti: false,
        pollAnonymous: false,
        pollPublic: false,
      }),
    ).toBe(false);
  });

  it.each([{ key: "pollAnonymous" }, { key: "pollPublic" }])(
    "treats channel-extra $key=true as poll creation intent",
    ({ key }) => {
      expect(
        hasPollCreationParams({
          [key]: true,
        }),
      ).toBe(true);
    },
  );

  it("treats non-zero finite numeric channel-extra poll params as poll creation intent", () => {
    expect(hasPollCreationParams({ pollDurationSeconds: 60 })).toBe(true);
    expect(hasPollCreationParams({ pollDurationSeconds: "60" })).toBe(true);
    expect(hasPollCreationParams({ pollDurationSeconds: "+60" })).toBe(true);
    expect(hasPollCreationParams({ pollDurationSeconds: "1e3" })).toBe(true);
    expect(hasPollCreationParams({ pollDurationSeconds: "-5" })).toBe(true);
    expect(hasPollCreationParams({ pollDurationSeconds: Infinity })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: "60abc" })).toBe(false);
    expect(hasPollCreationParams({ pollDurationSeconds: "0x10" })).toBe(false);
  });

  it("does not treat zero-valued numeric channel-extra poll params as poll creation intent", () => {
    // Zero values are typically defaults/unset values from tool schemas,
    // not intentional poll creation. Fixes #52118.
    expect(hasPollCreationParams({ pollDurationSeconds: 0 })).toBe(false);
    expect(hasPollCreationParams({ poll_duration_seconds: 0 })).toBe(false);
  });

  it("does not treat shared modifier params (pollDurationHours, pollMulti) as poll creation intent without a question or options", () => {
    // These two are exposed by the shared `message` tool schema for both
    // `send` and `poll` actions, so LLMs routinely schema-pad them on every
    // plain `send` call with their schema-implied defaults (1 for an integer
    // with `minimum: 1`, `false` for a boolean). Treating those defaults as
    // poll intent blocks routine sends — see the regression that motivated
    // this carve-out.
    expect(hasPollCreationParams({ pollDurationHours: 1 })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: 1, pollMulti: false })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: 0 })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: -1 })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: "0" })).toBe(false);
    expect(hasPollCreationParams({ pollDurationHours: Number.NaN })).toBe(false);
    expect(hasPollCreationParams({ poll_duration_hours: "0" })).toBe(false);
    expect(hasPollCreationParams({ pollMulti: true })).toBe(false);
  });

  it("still flags shared modifier params when accompanied by a question or options", () => {
    expect(hasPollCreationParams({ pollQuestion: "Ready?", pollDurationHours: 1 })).toBe(true);
    expect(hasPollCreationParams({ pollOption: ["Yes", "No"], pollMulti: true })).toBe(true);
  });

  it("treats string-encoded boolean poll params as poll creation intent when true", () => {
    expect(hasPollCreationParams({ pollPublic: "true" })).toBe(true);
    expect(hasPollCreationParams({ pollAnonymous: "false" })).toBe(false);
  });

  it("treats string poll options as poll creation intent", () => {
    expect(hasPollCreationParams({ pollOption: "Yes" })).toBe(true);
  });

  it("detects snake_case poll fields as poll creation intent", () => {
    expect(hasPollCreationParams({ poll_question: "Lunch?" })).toBe(true);
    expect(hasPollCreationParams({ poll_option: ["Pizza", "Sushi"] })).toBe(true);
    expect(hasPollCreationParams({ poll_duration_seconds: "60" })).toBe(true);
    expect(hasPollCreationParams({ poll_public: "true" })).toBe(true);
  });

  it("ignores poll vote params when deciding whether send should become poll", () => {
    expect(hasPollCreationParams({ pollId: "poll-1" })).toBe(false);
    expect(hasPollCreationParams({ pollOptionId: "answer-1" })).toBe(false);
    expect(hasPollCreationParams({ pollOptionIndexes: [1] })).toBe(false);
  });
});
