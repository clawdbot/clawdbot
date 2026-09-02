// Covers reply-type plugin actions: outbound text hygiene (citation control
// markers) and current-source delivery marking for implicit reply routes.
import { afterEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  registerReplyPlugin,
  runCurrentConversationPollAction as runPollAction,
  runReplyAction,
} from "./message-action-runner.test-support.js";

describe("runMessageAction reply-type plugin actions", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });
  it("marks replies to the run's inbound message as current-source deliveries", async () => {
    registerReplyPlugin();

    const result = await runReplyAction({
      actionParams: { message: "visible reply", messageId: "1783" },
      currentMessageId: "1783",
    });

    expect(result.kind).toBe("action");
    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
    const details = "toolResult" in result ? result.toolResult?.details : undefined;
    expect(details).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("matches numeric replied-to message ids against string tool-context ids", async () => {
    registerReplyPlugin();

    const result = await runReplyAction({
      actionParams: { message: "visible reply", messageId: 1783 },
      currentMessageId: "1783",
    });

    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("leaves replies to other messages unmarked", async () => {
    registerReplyPlugin();

    const result = await runReplyAction({
      actionParams: { message: "visible reply", messageId: "999" },
      currentMessageId: "1783",
    });

    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("leaves explicitly targeted replies unmarked", async () => {
    registerReplyPlugin();

    const result = await runReplyAction({
      actionParams: {
        message: "visible reply",
        messageId: "1783",
        to: "direct:someone-else",
      },
      currentMessageId: "1783",
    });

    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });

  it("marks polls sent to the current conversation as current-source deliveries", async () => {
    registerReplyPlugin();

    const result = await runPollAction({ to: "direct:user-1" });

    expect(result.kind).toBe("poll");
    expect(result.payload).toMatchObject({ sourceReplyRoute: "current-source" });
  });

  it("leaves polls sent to other conversations unmarked", async () => {
    registerReplyPlugin();

    const result = await runPollAction({ to: "direct:someone-else" });

    expect((result.payload as { sourceReplyRoute?: unknown }).sourceReplyRoute).toBeUndefined();
  });
});
