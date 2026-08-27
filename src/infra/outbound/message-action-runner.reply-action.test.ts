// Covers reply-type plugin actions: outbound text hygiene (citation control
// markers) and current-source delivery marking for implicit reply routes.
import { afterEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { registerReplyPlugin, runReplyAction } from "./message-action-runner.test-support.js";

const CITATION_MARKED_MESSAGE = "Ayutthaya Thai is my pick. citeturn2search9turn2search6";

function readHandledParams(handleAction: {
  mock: { calls: readonly unknown[][] };
}): Record<string, unknown> {
  const [call] = handleAction.mock.calls;
  const arg = call?.[0];
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
    throw new Error("expected plugin handleAction call");
  }
  const params = (arg as Record<string, unknown>).params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("expected plugin handleAction params");
  }
  return params as Record<string, unknown>;
}

describe("runMessageAction reply-type plugin actions", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });
  it("strips citation control markers from reply text before plugin dispatch", async () => {
    const handleAction = registerReplyPlugin();

    await runReplyAction({
      actionParams: { message: CITATION_MARKED_MESSAGE, messageId: "1783" },
      currentMessageId: "1783",
    });

    const handledParams = readHandledParams(handleAction);
    expect(handledParams.message).toBe("Ayutthaya Thai is my pick.");
  });
});
