import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveChatSendStopOwnerScope } from "./chat-send-stop-owner-scope.js";

describe("chat send stop ownership", () => {
  it("keeps the selected filter separate from the compatibility run fallback", () => {
    const cfg: OpenClawConfig = {
      session: { scope: "global", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    expect(
      resolveChatSendStopOwnerScope({
        cfg,
        selectedAgentId: "research",
        sessionKey: "global",
      }),
    ).toEqual({ agentId: "research", defaultAgentId: "ops" });
  });
});
