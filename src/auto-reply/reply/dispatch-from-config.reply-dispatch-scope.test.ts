import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDispatcher,
  emptyConfig,
  hookMocks,
  sessionBindingMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import {
  describe0BeforeEach0,
  dispatchReplyFromConfig,
  globalBeforeAll0,
  setNoAbort,
} from "./dispatch-from-config.test-harness.js";
import type { InternalGetReplyFromConfig } from "./get-reply.types.js";
import { buildTestCtx } from "./test-ctx.js";

beforeAll(globalBeforeAll0);

describe("dispatchReplyFromConfig reply hook scope", () => {
  beforeEach(() => {
    describe0BeforeEach0();
    setNoAbort();
  });

  it.each<{
    name: string;
    targetKey: string;
    expectedKind: "agent" | "acp";
    sourceKey?: string;
    metadata?: boolean;
    missing?: boolean;
    bound?: boolean;
    tail?: boolean;
  }>([
    { name: "local session", targetKey: "agent:test:session", expectedKind: "agent" },
    { name: "new session", targetKey: "agent:test:session", missing: true, expectedKind: "agent" },
    {
      name: "stale ACP key",
      targetKey: "agent:test:acp:missing",
      missing: true,
      expectedKind: "acp",
    },
    {
      name: "stored ACP session",
      targetKey: "agent:test:session",
      metadata: true,
      expectedKind: "acp",
    },
    {
      name: "ACP command target",
      sourceKey: "agent:test:source",
      targetKey: "agent:test:target",
      metadata: true,
      expectedKind: "acp",
    },
    {
      name: "local command target from ACP source",
      sourceKey: "agent:test:acp:source",
      targetKey: "agent:test:target",
      expectedKind: "agent",
    },
    {
      name: "bound ACP reset tail",
      sourceKey: "agent:test:discord:channel:C1",
      targetKey: "agent:test:acp:bound",
      bound: true,
      tail: true,
      expectedKind: "acp",
    },
  ])("scopes reply hooks to the prepared $name", async (scenario) => {
    const sourceKey = scenario.sourceKey ?? scenario.targetKey;
    const sourceEntry = { sessionId: "source-session", updatedAt: Date.now() };
    const targetEntry = scenario.missing
      ? undefined
      : {
          sessionId: "target-session",
          updatedAt: Date.now(),
          ...(scenario.metadata ? { acp: { backend: "acpx" } } : {}),
        };
    if (sourceKey !== scenario.targetKey) {
      sessionStoreMocks.entriesBySessionKey.set(sourceKey, sourceEntry);
    }
    if (targetEntry) {
      sessionStoreMocks.entriesBySessionKey.set(scenario.targetKey, targetEntry);
    }
    const readEntry = (...args: unknown[]) => {
      const { sessionKey } = args[0] as { sessionKey: string };
      return sessionStoreMocks.entriesBySessionKey.get(sessionKey);
    };
    sessionStoreMocks.loadSessionStoreEntry.mockImplementation(readEntry);
    sessionStoreMocks.loadSessionEntry.mockImplementation(readEntry);
    if (scenario.bound) {
      sessionBindingMocks.resolveByConversation.mockReturnValue({
        bindingId: "bound-dispatch-kind",
        targetSessionKey: scenario.targetKey,
        targetKind: "session",
        status: "active",
        boundAt: Date.now(),
        conversation: { channel: "discord", accountId: "default", conversationId: "C1" },
      });
    }
    hookMocks.runner.hasHooks.mockImplementation(
      (hookName, scope) => hookName === "reply_dispatch" && scope?.dispatchKind !== "agent",
    );
    hookMocks.runner.runReplyDispatch.mockImplementation(async (eventValue, contextValue) => {
      expect(eventValue).toMatchObject({ sessionKey: scenario.targetKey });
      expect(contextValue).toMatchObject({ dispatchKind: "acp" });
      const event = eventValue as { isTailDispatch?: boolean };
      return scenario.tail && !event.isTailDispatch
        ? undefined
        : {
            handled: true,
            queuedFinal: true,
            counts: { tool: 0, block: 0, final: 1 },
          };
    });
    const replyResolver = vi.fn<InternalGetReplyFromConfig>(async (ctx) => {
      if (scenario.tail) {
        ctx.AcpDispatchTailAfterReset = true;
        return undefined;
      }
      return { text: "local reply" };
    });
    const ctx = buildTestCtx({
      Body: "hello",
      BodyForAgent: "hello",
      SessionKey: sourceKey,
      Provider: "discord",
      Surface: "discord",
      To: "C1",
      AccountId: "default",
      ...(scenario.sourceKey && !scenario.bound
        ? { CommandSource: "native", CommandTargetSessionKey: scenario.targetKey }
        : {}),
    });
    const result = await dispatchReplyFromConfig({
      ctx,
      cfg: emptyConfig,
      dispatcher: createDispatcher(),
      replyResolver,
    });
    expect(result.queuedFinal).toBe(true);
    expect(hookMocks.runner.hasHooks).toHaveBeenCalledWith("reply_dispatch", {
      dispatchKind: scenario.expectedKind,
    });
    expect(hookMocks.runner.runReplyDispatch).toHaveBeenCalledTimes(
      scenario.expectedKind === "agent" ? 0 : scenario.tail ? 2 : 1,
    );
    expect(replyResolver).toHaveBeenCalledTimes(
      scenario.expectedKind === "agent" || scenario.tail ? 1 : 0,
    );
  });
});
