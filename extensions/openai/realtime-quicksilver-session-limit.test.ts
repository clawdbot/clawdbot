import { describe, expect, it } from "vitest";
import {
  releaseOpenAIQuicksilverSession,
  reserveOpenAIQuicksilverSession,
} from "./realtime-quicksilver-session-limit.js";

describe("GPT-Live shared session limit", () => {
  it("caps browser and relay owners together", () => {
    const owners = Array.from({ length: 9 }, () => Symbol("quicksilver-session"));
    try {
      for (const owner of owners.slice(0, 8)) {
        reserveOpenAIQuicksilverSession(owner);
      }
      expect(() => reserveOpenAIQuicksilverSession(owners[8])).toThrow(
        "Too many concurrent OpenAI GPT-Live sessions",
      );
      releaseOpenAIQuicksilverSession(owners[0]);
      expect(() => reserveOpenAIQuicksilverSession(owners[8])).not.toThrow();
    } finally {
      for (const owner of owners) {
        releaseOpenAIQuicksilverSession(owner);
      }
    }
  });
});
