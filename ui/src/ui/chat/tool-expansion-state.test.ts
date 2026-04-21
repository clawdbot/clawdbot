import { afterEach, describe, expect, it } from "vitest";
import type { MessageGroup } from "../types/chat-types.ts";
import {
  getExpandedToolCards,
  resetToolExpansionStateForTest,
  syncToolCardExpansionState,
} from "./tool-expansion-state.ts";

afterEach(() => {
  resetToolExpansionStateForTest();
});

function createGroup(message: unknown, key = "assistant-1"): MessageGroup {
  return {
    kind: "group",
    key,
    role: "assistant",
    messages: [{ key, message }],
    timestamp: 1,
    isStreaming: false,
  };
}

describe("tool expansion state", () => {
  it("expands already-visible tool cards when auto-expand turns on", () => {
    const group = createGroup({
      role: "assistant",
      content: [
        {
          type: "toolcall",
          id: "call-1",
          name: "browser.open",
          arguments: { url: "https://example.com" },
        },
      ],
    });

    syncToolCardExpansionState("main", [group], false);
    expect(getExpandedToolCards("main").get("assistant-1:toolcard:0")).toBe(false);

    syncToolCardExpansionState("main", [group], true);
    expect(getExpandedToolCards("main").get("assistant-1:toolcard:0")).toBe(true);
  });
});
