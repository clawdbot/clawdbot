import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { describe, expect, it } from "vitest";
import {
  recordTelegramGroupHistoryEntry,
  removeTelegramGroupHistoryEntry,
} from "./group-history-window.js";

describe("Telegram group history lifecycle metadata", () => {
  it("removes an album entry by a non-primary member without exposing provider metadata", () => {
    const historyMap = new Map<string, HistoryEntry[]>();
    const entry: HistoryEntry = {
      sender: "Ada",
      body: "private album detail",
      messageId: "10",
    };

    recordTelegramGroupHistoryEntry({
      historyMap,
      historyKey: "telegram:-1001",
      limit: 5,
      entry,
      sourceMessageIds: ["10", "11"],
    });

    expect(JSON.stringify(entry)).toBe(
      '{"sender":"Ada","body":"private album detail","messageId":"10"}',
    );
    expect(
      removeTelegramGroupHistoryEntry({
        historyMap,
        historyKey: "telegram:-1001",
        messageId: "11",
      }),
    ).toBe(true);
    expect(historyMap.has("telegram:-1001")).toBe(false);
  });
});
