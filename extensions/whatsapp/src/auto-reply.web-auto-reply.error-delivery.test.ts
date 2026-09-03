// WhatsApp web auto-reply terminal failure delivery behavior.
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMockWebListener,
  createWebInboundDeliverySpies,
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  sendWebDirectInboundMessage,
  sendWebGroupInboundMessage,
} from "./auto-reply.test-harness.js";
import type { WebInboundCallbackMessage } from "./inbound.js";

installWebAutoReplyTestHomeHooks();

let monitorWebChannel: typeof import("./auto-reply/monitor.js").monitorWebChannel;

const TERMINAL_FAILURE_TEXT = "⚠️ The model ended this turn without answering.";
const SELF_JID = "123@s.whatsapp.net";

describe("web auto-reply terminal failure delivery", () => {
  installWebAutoReplyUnitTestHooks({ pinDns: true });
  type ListenerFactory = NonNullable<Parameters<typeof monitorWebChannel>[1]>;

  beforeAll(async () => {
    ({ monitorWebChannel } = await import("./auto-reply/monitor.js"));
  });

  async function startMonitorWithTerminalFailure(): Promise<{
    spies: ReturnType<typeof createWebInboundDeliverySpies>;
    onMessage: (msg: WebInboundCallbackMessage) => Promise<void>;
  }> {
    const spies = createWebInboundDeliverySpies();
    const resolver = vi.fn().mockResolvedValue({ text: TERMINAL_FAILURE_TEXT, isError: true });
    let capturedOnMessage: Parameters<ListenerFactory>[0]["onMessage"] | undefined;
    const listenerFactory: ListenerFactory = async ({ onMessage }) => {
      capturedOnMessage = onMessage;
      return createMockWebListener();
    };

    await monitorWebChannel(false, listenerFactory, false, resolver);
    if (!capturedOnMessage) {
      throw new Error("expected WhatsApp web message handler");
    }
    return { spies, onMessage: capturedOnMessage };
  }

  it("sends a terminal failure final to a direct chat", async () => {
    const { spies, onMessage } = await startMonitorWithTerminalFailure();

    await sendWebDirectInboundMessage({
      onMessage,
      spies,
      id: "direct-terminal-failure",
      from: "+1000",
      to: "+2000",
      body: "hello",
    });

    expect(spies.reply).toHaveBeenCalledTimes(1);
    const sentText = spies.reply.mock.calls[0]?.[0];
    expect(sentText).toContain(TERMINAL_FAILURE_TEXT);
    // Suppressing the terminal failure previously left core to substitute its generic
    // no-visible-reply fallback, which hides the real reason the turn ended.
    expect(sentText).not.toContain("No reply was generated");
  });

  it("sends a terminal failure final to a group chat", async () => {
    const { spies, onMessage } = await startMonitorWithTerminalFailure();

    await sendWebGroupInboundMessage({
      onMessage,
      spies,
      id: "group-terminal-failure",
      body: "hello",
      senderE164: "+1000",
      senderName: "Tester",
      selfE164: "+2000",
      selfJid: SELF_JID,
      mentionedJids: [SELF_JID],
    });

    expect(spies.reply).toHaveBeenCalledTimes(1);
    expect(spies.reply.mock.calls[0]?.[0]).toContain(TERMINAL_FAILURE_TEXT);
  });
});
