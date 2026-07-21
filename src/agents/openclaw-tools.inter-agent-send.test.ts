// Verifies createOpenClawTools drops sessions_send on a sessions_send A2A turn so
// the target cannot reverse-call the requester and duplicate content (issue #39476).
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { createOpenClawTools } from "./openclaw-tools.js";

const BASE_OPTIONS = {
  agentSessionKey: "agent:main:discord:channel:target-room",
  agentChannel: "discord",
  // Keep construction to shipped core tools so the assertion stays focused.
  disableMessageTool: true,
  disablePluginTools: true,
} as const;

function toolNames(options: Parameters<typeof createOpenClawTools>[0]): string[] {
  return createOpenClawTools(options).map((tool) => tool.name);
}

describe("createOpenClawTools sessions_send A2A gate", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("exposes sessions_send on a normal turn", () => {
    expect(toolNames(BASE_OPTIONS)).toContain("sessions_send");
  });

  it("omits sessions_send when the turn is itself a sessions_send A2A turn", () => {
    const names = toolNames({ ...BASE_OPTIONS, interAgentSendTurn: true });
    expect(names).not.toContain("sessions_send");
    // Only the reverse-call vector is removed; other session/conversation tools
    // remain available during the routed turn.
    expect(names).toContain("sessions_list");
    expect(names).toContain("sessions_history");
    expect(names).toContain("sessions_search");
    expect(names).toContain("conversations_list");
  });
});
