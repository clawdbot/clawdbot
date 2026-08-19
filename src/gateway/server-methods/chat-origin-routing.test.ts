import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRequestedChatAgentId } from "./chat-origin-routing.js";

describe("chat session owner resolution", () => {
  it("uses configured fixed-store ownership for bare keys", () => {
    const cfg: OpenClawConfig = {
      session: { store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    expect(resolveRequestedChatAgentId({ cfg, requestedSessionKey: "global" })).toEqual({
      ok: true,
      agentId: "ops",
    });
  });

  it("returns the typed selection error for ownerless bare keys", () => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };

    expect(resolveRequestedChatAgentId({ cfg, requestedSessionKey: "global" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("has no explicit owner") },
    });
  });
});
