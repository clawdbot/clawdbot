// Verifies destination-aware sessions_send guards keep nested handoffs available.
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

  it("keeps sessions_send available on an A2A target turn", () => {
    const names = toolNames({
      ...BASE_OPTIONS,
      sessionsSendCallerSessionKey: "agent:requester:discord:channel:source-room",
    });
    expect(names).toContain("sessions_send");
    expect(names).toContain("sessions_list");
    expect(names).toContain("sessions_history");
    expect(names).toContain("sessions_search");
    expect(names).toContain("conversations_list");
  });
});
