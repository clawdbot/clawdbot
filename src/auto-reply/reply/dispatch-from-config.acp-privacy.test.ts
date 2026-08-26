import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  acpMocks,
  hookMocks,
  mocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  createAcpRuntime,
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig ACP reply privacy", () => {
  beforeEach(describe0BeforeEach0);

  it("strips private prompt context before routing an ACP reply through its dispatch hook", async () => {
    setNoAbort();
    const conversationContext = [
      "[Chat messages since your last reply - for context]",
      "[Discord] Alice: private history",
      "",
      "[Current message - respond to this]",
      '<function_calls><invoke name="exec">private XML</invoke></function_calls>',
      "private inbound paragraph",
    ].join("\n");
    const sessionKey = "agent:codex-acp:privacy-session";
    const runtime = createAcpRuntime([
      { type: "text_delta", text: `${conversationContext}\n\nVisible answer.` },
      { type: "done" },
    ]);
    sessionStoreMocks.currentEntry = { sessionId: "privacy-session", updatedAt: Date.now() };
    acpMocks.readAcpSessionEntry.mockReturnValue({
      sessionKey,
      storeSessionKey: sessionKey,
      cfg: {},
      storePath: "/tmp/mock-sessions.json",
      entry: sessionStoreMocks.currentEntry,
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime:privacy",
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    acpMocks.requireAcpRuntimeBackend.mockReturnValue({ id: "acpx", runtime });

    const dispatcher = createReplyDispatcher({ deliver: vi.fn(async () => {}) });
    await dispatchReplyFromConfig({
      ctx: buildTestCtx({
        Body: conversationContext,
        BodyForAgent: conversationContext,
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "telegram",
        OriginatingTo: "telegram:999",
        SessionKey: sessionKey,
      }),
      cfg: {
        acp: {
          enabled: true,
          dispatch: { enabled: true },
          stream: { deliveryMode: "final_only" },
        },
        session: { sendPolicy: { default: "allow" } },
      } satisfies OpenClawConfig,
      dispatcher,
    });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledOnce();
    expect(runtime.runTurn).toHaveBeenCalledOnce();
    expect(mocks.routeReply).toHaveBeenCalledOnce();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        payload: expect.objectContaining({ text: "Visible answer." }),
      }),
    );
  });
});
