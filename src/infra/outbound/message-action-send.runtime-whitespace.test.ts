// Real-behavior proof: a formatted reasoning preamble followed by an indented
// body flows through the full runtime message-action send path (runMessageAction
// -> buildMessagePayload -> channel outbound adapter) with leading whitespace
// intact, reaching the channel sendText call exactly as the model produced it.
// Pre-fix, the alias read trimmed the body, so the channel received flattened
// text and Markdown indented code blocks lost their indentation at delivery.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

function firstSendTextArg(mock: {
  mock: { calls: readonly unknown[][] };
}): Record<string, unknown> {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected sendText call");
  }
  const [arg] = call;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error("expected sendText input to be an object");
  }
  return arg as Record<string, unknown>;
}

describe("runMessageAction runtime whitespace preservation", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("delivers an indented code block through the text alias with leading whitespace intact", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "t1",
      chatId: "c1",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "testchat",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );
    const cfg = {
      channels: { testchat: { enabled: true } },
    } as OpenClawConfig;

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        text: ["Thinking...", "_brief summary_", "", "    const value = 1;"].join("\n"),
      },
      dryRun: false,
    });

    expect(result.kind).toBe("send");
    expect(sendText).toHaveBeenCalledOnce();
    const delivered = firstSendTextArg(sendText);
    expect(delivered.text).toBe("    const value = 1;");
  });

  it("delivers an explicit indented message with leading whitespace intact", async () => {
    const sendText = vi.fn().mockResolvedValue({
      channel: "testchat",
      messageId: "t2",
      chatId: "c2",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "testchat",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "testchat",
            outbound: { deliveryMode: "direct", sendText },
          }),
        },
      ]),
    );
    const cfg = {
      channels: { testchat: { enabled: true } },
    } as OpenClawConfig;

    await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "testchat",
        target: "channel:abc",
        message: "    function foo() {\n      return 1;\n    }",
      },
      dryRun: false,
    });

    expect(sendText).toHaveBeenCalledOnce();
    const delivered = firstSendTextArg(sendText);
    expect(delivered.text).toBe("    function foo() {\n      return 1;\n    }");
  });
});
