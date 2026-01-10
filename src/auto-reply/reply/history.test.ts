import { describe, expect, it } from "vitest";
import {
  appendHistoryEntry,
  buildHistoryContext,
  buildHistoryContextFromEntries,
  HISTORY_CONTEXT_MARKER,
} from "./history.js";
import { CURRENT_MESSAGE_MARKER } from "./mentions.js";

describe("history helpers", () => {
  it("returns current message when history is empty", () => {
    const result = buildHistoryContext({
      historyText: "  ",
      currentMessage: "hello",
    });
    expect(result).toBe("hello");
  });

  it("wraps history entries and excludes current by default", () => {
    const result = buildHistoryContextFromEntries({
      entries: [
        { sender: "A", body: "one" },
        { sender: "B", body: "two" },
      ],
      currentMessage: "current",
      formatEntry: (entry) => `${entry.sender}: ${entry.body}`,
    });

    expect(result).toContain(HISTORY_CONTEXT_MARKER);
    expect(result).toContain("A: one");
    expect(result).not.toContain("B: two");
    expect(result).toContain(CURRENT_MESSAGE_MARKER);
    expect(result).toContain("current");
  });

  it("trims history to configured limit", () => {
    const historyMap = new Map<string, { sender: string; body: string }[]>();

    appendHistoryEntry({
      historyMap,
      historyKey: "room",
      limit: 2,
      entry: { sender: "A", body: "one" },
    });
    appendHistoryEntry({
      historyMap,
      historyKey: "room",
      limit: 2,
      entry: { sender: "B", body: "two" },
    });
    appendHistoryEntry({
      historyMap,
      historyKey: "room",
      limit: 2,
      entry: { sender: "C", body: "three" },
    });

    expect(historyMap.get("room")?.map((entry) => entry.body)).toEqual([
      "two",
      "three",
    ]);
  });
});
