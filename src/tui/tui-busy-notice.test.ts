import { describe, expect, it } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { ChatLog } from "./components/chat-log.js";
import { addBlockedChatSubmitNotice } from "./tui-busy-notice.js";

describe("addBlockedChatSubmitNotice", () => {
  it("coalesces repeated busy submit notices", () => {
    const chatLog = new ChatLog(20);

    addBlockedChatSubmitNotice(chatLog);
    addBlockedChatSubmitNotice(chatLog);
    addBlockedChatSubmitNotice(chatLog);

    const rendered = normalizeTestText(chatLog.render(120).join("\n"));
    expect(chatLog.children.length).toBe(1);
    expect(rendered).toContain(
      "agent is busy — press Esc to abort before sending a new message x3",
    );
  });
});
