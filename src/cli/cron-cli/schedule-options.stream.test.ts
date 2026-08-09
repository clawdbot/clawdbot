import { describe, expect, it } from "vitest";
import {
  applyExistingStreamSchedulePatch,
  resolveCronCreateScheduleFromArgs,
  resolveCronEditScheduleRequest,
} from "./schedule-options.js";

describe("resolveCronCreateScheduleFromArgs --stream-command", () => {
  it("builds an argv stream schedule with batching and match options", () => {
    expect(
      resolveCronCreateScheduleFromArgs({
        streamCommand: '["node","events.mjs"]',
        streamCwd: "/repo",
        streamMode: "match",
        streamMatch: "^ready:",
        streamBatchMs: "100",
        streamMaxBatchBytes: "2048",
      }),
    ).toEqual({
      kind: "stream",
      command: ["node", "events.mjs"],
      cwd: "/repo",
      mode: "match",
      match: "^ready:",
      batchMs: 100,
      maxBatchBytes: 2048,
    });
  });

  it("requires a valid argv array and match expression when requested", () => {
    expect(() => resolveCronCreateScheduleFromArgs({ streamCommand: "node events.mjs" })).toThrow(
      "JSON array",
    );
    expect(() =>
      resolveCronCreateScheduleFromArgs({
        streamCommand: '["node","events.mjs"]',
        streamMode: "match",
      }),
    ).toThrow("--stream-match is required");
  });

  it("rejects stream-only options without a stream command", () => {
    expect(() => resolveCronCreateScheduleFromArgs({ every: "1m", streamBatchMs: "250" })).toThrow(
      "require --stream-command",
    );
  });

  it("patches an existing stream back to line mode without restating argv", () => {
    const request = resolveCronEditScheduleRequest({ streamMode: "line" });
    expect(request.kind).toBe("patch-existing-stream");
    if (request.kind !== "patch-existing-stream") {
      throw new Error("expected stream patch");
    }
    expect(
      applyExistingStreamSchedulePatch(
        {
          kind: "stream",
          command: ["node", "events.mjs"],
          mode: "match",
          match: "^ready:",
          batchMs: 100,
        },
        request,
      ),
    ).toEqual({
      kind: "stream",
      command: ["node", "events.mjs"],
      mode: "line",
      match: undefined,
      batchMs: 100,
      cwd: undefined,
      maxBatchBytes: undefined,
    });
  });

  it("defers command replacement metadata checks until existing match settings are merged", () => {
    const commandAndMatch = resolveCronEditScheduleRequest({
      streamCommand: '["node","replacement.mjs"]',
      streamMatch: "^updated:",
    });
    expect(commandAndMatch.kind).toBe("direct");
    const matchPatch = resolveCronEditScheduleRequest({ streamMatch: "^updated:" });
    expect(matchPatch.kind).toBe("patch-existing-stream");
    if (matchPatch.kind !== "patch-existing-stream") {
      throw new Error("expected stream patch");
    }
    expect(
      applyExistingStreamSchedulePatch(
        {
          kind: "stream",
          command: ["node", "events.mjs"],
          mode: "match",
          match: "^ready:",
        },
        matchPatch,
      ),
    ).toMatchObject({ mode: "match", match: "^updated:" });

    expect(() =>
      resolveCronEditScheduleRequest({
        streamCommand: '["node","replacement.mjs"]',
        streamMode: "match",
      }),
    ).not.toThrow();
  });

  it("rejects time-schedule modifiers mixed into stream metadata edits", () => {
    expect(() => resolveCronEditScheduleRequest({ streamBatchMs: "100", tz: "UTC" })).toThrow(
      "not valid with stream schedule edits",
    );
    expect(() => resolveCronEditScheduleRequest({ streamMode: "line", exact: true })).toThrow(
      "not valid with stream schedule edits",
    );
  });
});
