import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDispatcher,
  emptyConfig,
  mocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
} from "./dispatch-from-config.test-harness.js";
import { buildTestCtx } from "./test-ctx.js";

await globalBeforeAll0();

describe("dispatchReplyFromConfig fast-abort model selection", () => {
  beforeEach(describe0BeforeEach0);

  it("seeds direct fast-abort prefixes from the session-selected model", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({ handled: true, aborted: true });
    sessionStoreMocks.currentEntry = {
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6-20260205",
      thinkingLevel: "high",
    };
    const onModelSelected = vi.fn();

    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        Body: "/stop",
        SessionKey: "agent:main:telegram:direct:123",
      }),
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      fastAbortResolver: mocks.tryFastAbortFromMessage,
      formatAbortReplyTextResolver: () => "⚙️ Agent was aborted.",
      replyOptions: { onModelSelected },
    });

    expect(onModelSelected).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-opus-4-6-20260205",
      thinkLevel: "high",
    });
  });
});
