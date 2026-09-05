import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createTalkClientGatewayControlOwner,
  createTalkRealtimeRunControlOwner,
} from "./talk-client-gateway-control.js";
import {
  controlBridge,
  controlContext,
  sessionTarget,
} from "./talk-client-gateway-control.test-support.js";

const statusResult = {
  ok: true,
  mode: "status" as const,
  sessionKey: sessionTarget.canonicalKey,
  active: false,
  message: "No active request.",
  speak: true,
  show: true,
  suppress: false,
};

describe("native Talk control admission", () => {
  it.each(["readiness", "execution"] as const)(
    "answers a live %s failure once",
    async (failure) => {
      const execute = vi.fn(async () => {
        if (failure === "execution") {
          throw new Error("private execution failure");
        }
        return statusResult;
      });
      const ready = vi.fn(async () => {
        if (failure === "readiness") {
          throw new Error("private readiness failure");
        }
      });
      const respond = vi.fn();
      const owner = createTalkRealtimeRunControlOwner({
        controlSource: "delegation",
        hasActiveRun: () => false,
        prepare: () => execute,
        speak: vi.fn(),
        warn: vi.fn(),
      });
      expect(owner.handleDelegationInput?.("status", respond, ready)).toBe("control");
      await owner.close();
      expect(respond).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Please try again."));
      expect(respond.mock.calls[0]?.[0]).not.toContain("private");
      expect(execute).toHaveBeenCalledTimes(failure === "readiness" ? 0 : 1);
    },
  );

  it("does not acquire readiness for task fallthrough or saturated controls and does not retry a throwing result sink", async () => {
    const release = createDeferred();
    const ready = vi.fn(() => release.promise);
    const execute = vi.fn(async () => statusResult);
    const warn = vi.fn();
    const owner = createTalkRealtimeRunControlOwner({
      controlSource: "delegation",
      hasActiveRun: () => false,
      prepare: () => execute,
      speak: vi.fn(),
      warn,
    });
    const overflowReply = vi.fn();
    const throwingReply = vi.fn(() => {
      throw new Error("send failed");
    });
    try {
      expect(owner.handleDelegationInput?.("Check the weather.", vi.fn(), ready)).toBe("consult");
      expect(ready).not.toHaveBeenCalled();
      for (let index = 0; index < 9; index += 1) {
        owner.handleDelegationInput?.("status", index === 0 ? throwingReply : vi.fn(), ready);
      }
      owner.handleDelegationInput?.("cancel", overflowReply, ready);
      expect(ready).toHaveBeenCalledOnce();
      expect(overflowReply).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("queue is full"),
      );
      release.resolve();
      await owner.close();
      expect(ready).toHaveBeenCalledTimes(9);
      expect(execute).toHaveBeenCalledTimes(9);
      expect(throwingReply).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("send failed"));
    } finally {
      release.resolve();
      await owner.close();
    }
  });

  it.each(["close", "replace", "disconnect"] as const)(
    "fences retained native input and awaited replies after %s",
    async (ending) => {
      const result = createDeferred<typeof statusResult>();
      const controlAgentRun = vi.fn(async () => await result.promise);
      let connected = true;
      const common = {
        voiceSessionId: `native-fence-${ending}`,
        connId: `native-fence-${ending}`,
        sessionTarget,
        controlSource: "delegation" as const,
        context: controlContext(),
        assertConnectionOpen: () => {
          if (!connected) {
            throw new Error("disconnected");
          }
        },
        runAgentConsult: vi.fn(async () => ({ text: "unexpected task" })),
        appendTranscript: vi.fn(async () => undefined),
        flushTranscript: vi.fn(async () => undefined),
        closeLogicalSession: vi.fn(async () => undefined),
        controlAgentRun,
      };
      const owner = createTalkClientGatewayControlOwner(common);
      const bridge = controlBridge();
      owner.control.bindBridge(bridge);
      await owner.adoptProvider(vi.fn(async () => undefined));
      owner.activate();
      let replacement: ReturnType<typeof createTalkClientGatewayControlOwner> | undefined;
      const respond = vi.fn();
      const handleInput = owner.control.handleDelegationInput!;
      try {
        owner.control.onTranscript?.("user", "status", true);
        expect(common.appendTranscript).toHaveBeenCalledOnce();
        expect(controlAgentRun).not.toHaveBeenCalled();
        expect(handleInput("status", respond)).toBe("control");
        await vi.waitFor(() => expect(controlAgentRun).toHaveBeenCalledOnce());
        if (ending === "replace") {
          replacement = createTalkClientGatewayControlOwner(common);
          await replacement.adoptProvider(vi.fn(async () => undefined));
          replacement.activate();
        } else if (ending === "disconnect") {
          connected = false;
        } else {
          void owner.close();
        }
        expect(() => handleInput("Check the weather.", respond)).toThrow(/closed|disconnected/);
        result.resolve(statusResult);
        await owner.close();
        expect(controlAgentRun).toHaveBeenCalledOnce();
        expect(respond).not.toHaveBeenCalled();
        expect(bridge.sendUserMessage).not.toHaveBeenCalled();
        expect(common.runAgentConsult).not.toHaveBeenCalled();
      } finally {
        result.resolve(statusResult);
        await owner.close();
        await replacement?.close();
      }
    },
  );
});
