import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { shouldIncludeAskUserToolForOpenClawTools } from "./openclaw-tools.registration.js";

vi.mock("./openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

const toolNames = (options: Parameters<typeof createOpenClawCodingTools>[0]) =>
  createOpenClawCodingTools(options).map((tool) => tool.name);

describe("ask_user tool registration", () => {
  afterEach(() => resetPluginRuntimeStateForTest());

  it("requires a primary session and a prepared question-input capability", () => {
    expect(
      shouldIncludeAskUserToolForOpenClawTools({
        agentSessionKey: "agent:main:main",
        questionInputMode: "native",
      }),
    ).toBe(true);
    for (const agentSessionKey of [
      undefined,
      "agent:main:subagent:worker",
      "agent:main:acp:worker",
    ]) {
      expect(
        shouldIncludeAskUserToolForOpenClawTools({ agentSessionKey, questionInputMode: "native" }),
      ).toBe(false);
    }
    expect(shouldIncludeAskUserToolForOpenClawTools({ agentSessionKey: "agent:main:main" })).toBe(
      false,
    );
  });

  it.each(["imessage", "mattermost", "signal", "unknown-question-channel", "whatsapp"])(
    "omits ask_user from non-interactive %s",
    (messageChannel) =>
      expect(
        toolNames({
          sessionKey: "agent:main:run",
          messageChannel,
          messageProvider: "discord",
          messageTo: "discord:channel:outbound-target",
        }),
      ).not.toContain("ask_user"),
  );

  it("keeps ask_user for native surfaces and declared button support unless policy denies it", () => {
    const registry = createEmptyPluginRegistry();
    registry.channels.push({
      plugin: {
        id: "question-fixture",
        agentPrompt: { questionInputMode: "buttons" },
      },
    } as never);
    setActivePluginRegistry(registry);

    for (const messageChannel of ["webchat", "question-fixture"]) {
      expect(toolNames({ sessionKey: "agent:main:run", messageChannel })).toContain("ask_user");
    }
    expect(
      toolNames({
        sessionKey: "agent:main:run",
        messageChannel: "webchat",
        config: { tools: { deny: ["ask_user"] } },
      }),
    ).not.toContain("ask_user");
  });
});
