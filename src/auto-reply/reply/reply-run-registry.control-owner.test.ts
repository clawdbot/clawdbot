import { afterEach, describe, expect, it } from "vitest";
import { replyRunRegistry } from "./reply-run-registry.js";
import { resolveActiveReplyRunOwnerForSignal } from "./reply-run-registry.state.js";

const sessionKey = "agent:main:voice-control";

afterEach(() => replyRunRegistry.get(sessionKey)?.complete());

describe("reply run control ownership", () => {
  it.each(["key", "sessionId"] as const)(
    "fences retained controls after its %s changes",
    (field) => {
      const controller = new AbortController();
      const operation = replyRunRegistry.begin({
        sessionKey,
        sessionId: "original-session",
        resetTriggered: false,
        upstreamAbortSignal: controller.signal,
      });
      try {
        const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
        if (field === "key") {
          operation.updateSessionKey("agent:main:voice-control-rekeyed");
        } else {
          operation.updateSessionId("replacement-session");
        }
        expect(owner?.abort()).toBe(false);
        expect(operation.abortSignal.aborted).toBe(false);
      } finally {
        operation.complete();
      }
    },
  );

  it("controls a queued reply only through its admitted upstream signal", () => {
    const controller = new AbortController();
    const operation = replyRunRegistry.begin({
      sessionKey,
      sessionId: "queued-session",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    expect(resolveActiveReplyRunOwnerForSignal(new AbortController().signal)).toBeUndefined();
    const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
    expect(owner?.sessionId).toBe("queued-session");
    expect(owner?.abort()).toBe(true);
    expect(operation.abortSignal.aborted).toBe(true);
    expect(resolveActiveReplyRunOwnerForSignal(controller.signal)).toBeUndefined();
  });

  it("fences retained controls after same-session replacement", () => {
    const controller = new AbortController();
    const operation = replyRunRegistry.begin({
      sessionKey,
      sessionId: "same-session",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    const owner = resolveActiveReplyRunOwnerForSignal(controller.signal);
    operation.complete();
    const successor = replyRunRegistry.begin({
      sessionKey,
      sessionId: "same-session",
      resetTriggered: false,
      upstreamAbortSignal: new AbortController().signal,
    });
    expect(resolveActiveReplyRunOwnerForSignal(controller.signal)).toBeUndefined();
    expect(owner?.abort()).toBe(false);
    expect(successor.abortSignal.aborted).toBe(false);
  });
});
