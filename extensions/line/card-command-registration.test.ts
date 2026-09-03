// Line tests cover which channels the bundled /card registration is offered on.
import type { OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it } from "vitest";
import lineEntry from "./index.js";

function registeredCardCommand(): OpenClawPluginCommandDefinition {
  const commands: OpenClawPluginCommandDefinition[] = [];
  lineEntry.register(
    createTestPluginApi({
      // Exercise the shipped registration without loading the full channel runtime.
      registrationMode: "tool-discovery",
      registerCommand(command) {
        commands.push(command);
      },
    }),
  );
  const card = commands.find((command) => command.name === "card");
  if (!card) {
    throw new Error("LINE did not register a /card command");
  }
  return card;
}

describe("line /card registration", () => {
  it("offers the command on LINE only", () => {
    expect(registeredCardCommand()).toMatchObject({
      channels: ["line"],
      acceptsArgs: true,
      requireAuth: false,
    });
  });

  it("renders a card through the registered lazy handler", async () => {
    const args = 'info "Welcome" "Thanks for joining!"';
    await expect(
      registeredCardCommand().handler({
        channel: "line",
        isAuthorizedSender: false,
        commandBody: `/card ${args}`,
        args,
        config: {},
        requestConversationBinding: async () => ({ status: "error", message: "unused" }),
        detachConversationBinding: async () => ({ removed: false }),
        getCurrentConversationBinding: async () => null,
      }),
    ).resolves.toMatchObject({
      channelData: {
        line: {
          flexMessage: { altText: "Welcome: Thanks for joining!", contents: { type: "bubble" } },
        },
      },
    });
  });
});
