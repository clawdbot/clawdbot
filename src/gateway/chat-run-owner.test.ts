import { describe, expect, it } from "vitest";
import {
  chatRunBelongsToAgent,
  chatRunBelongsToSelectedAgent,
  resolveChatRunOwnerAgentId,
} from "./chat-run-owner.js";

describe("chat run owner resolution", () => {
  it("uses the compatibility owner for a global run without agentId", () => {
    const run = { sessionKey: "global", defaultAgentId: "ops" };

    expect(resolveChatRunOwnerAgentId(run)).toBe("ops");
    expect(chatRunBelongsToAgent(run, "research")).toBe(false);
    expect(chatRunBelongsToAgent(run, "ops")).toBe(true);
    expect(chatRunBelongsToSelectedAgent({ ...run, selectedAgentId: "research" })).toBe(false);
  });

  it("keeps an explicit active-run owner ahead of the compatibility owner", () => {
    expect(
      resolveChatRunOwnerAgentId({
        agentId: "research",
        sessionKey: "global",
        defaultAgentId: "ops",
      }),
    ).toBe("research");
  });
});
