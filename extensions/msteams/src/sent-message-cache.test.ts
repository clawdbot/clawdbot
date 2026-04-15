import { describe, expect, it } from "vitest";
import {
  clearMSTeamsSentMessageCache,
  recordMSTeamsSentMessage,
  wasMSTeamsMessageSent,
} from "./sent-message-cache.js";

describe("msteams sent message cache", () => {
  it("records and resolves sent message ids", () => {
    clearMSTeamsSentMessageCache();
    recordMSTeamsSentMessage("conv-1", "msg-1");
    expect(wasMSTeamsMessageSent("conv-1", "msg-1")).toBe(true);
    expect(wasMSTeamsMessageSent("conv-1", "msg-2")).toBe(false);
  });
});
