import { describe, expect, it, vi } from "vitest";
import type {
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceBridgeCallbacks,
} from "./provider-types.js";
import { createRealtimeVoiceBridgeSession } from "./session-runtime.js";
import { makeBridge } from "./session-runtime.test-support.js";

describe("native delegation session facade", () => {
  it.each([false, true])(
    "preserves hook absence and blocks pre-adoption input (enabled=%s)",
    (enabled) => {
      const handleDelegationInput = vi.fn(() => "control" as const);
      const respond = vi.fn();
      let request!: RealtimeVoiceBridgeCreateRequest;
      const session = createRealtimeVoiceBridgeSession({
        provider: {
          id: "native-test",
          label: "Native Test",
          isConfigured: () => true,
          createBridge: (next) => {
            request = next;
            expect(next.handleDelegationInput?.("status", respond)).toBe(
              enabled ? "control" : undefined,
            );
            expect(handleDelegationInput).not.toHaveBeenCalled();
            return makeBridge();
          },
        },
        providerConfig: {},
        audioSink: { sendAudio: vi.fn() },
        ...(enabled ? { handleDelegationInput } : {}),
      });
      try {
        expect(Object.hasOwn(request, "handleDelegationInput")).toBe(enabled);
        // Buffered native input can arrive after adoption but before any ready event.
        expect(request.handleDelegationInput?.("status", respond)).toBe(
          enabled ? "control" : undefined,
        );
        expect(handleDelegationInput).toHaveBeenCalledTimes(enabled ? 1 : 0);
        expect(respond).not.toHaveBeenCalled();
      } finally {
        session.close();
      }
    },
  );

  it.each(["close", "provider-close"] as const)(
    "fences retained actions and responses after %s but preserves final transcript flush",
    (ending) => {
      let request!: RealtimeVoiceBridgeCreateRequest;
      let reply: ((text: string) => void) | undefined;
      const handleDelegationInput = vi.fn<
        NonNullable<RealtimeVoiceBridgeCallbacks["handleDelegationInput"]>
      >((_text, respond) => {
        reply = respond;
        return "control";
      });
      const onTranscript = vi.fn();
      const session = createRealtimeVoiceBridgeSession({
        provider: {
          id: "native-test",
          label: "Native Test",
          isConfigured: () => true,
          createBridge: (next) => {
            request = next;
            return makeBridge({
              close: () => next.onTranscript?.("assistant", "final flush", true),
            });
          },
        },
        providerConfig: {},
        audioSink: { sendAudio: vi.fn() },
        handleDelegationInput,
        onTranscript,
      });
      const respond = vi.fn();
      expect(request.handleDelegationInput?.("status", respond)).toBe("control");
      if (ending === "provider-close") {
        request.onClose?.("completed");
      }
      session.close();
      expect(request.handleDelegationInput?.("late task", respond)).toBe("control");
      reply?.("late result");
      expect(respond).not.toHaveBeenCalled();
      expect(handleDelegationInput).toHaveBeenCalledOnce();
      expect(onTranscript).toHaveBeenCalledExactlyOnceWith("assistant", "final flush", true);
    },
  );

  it.each([false, true])(
    "contains callback failure without task fallthrough or a second reply (replied=%s)",
    (replied) => {
      let request!: RealtimeVoiceBridgeCreateRequest;
      const onError = vi.fn();
      const session = createRealtimeVoiceBridgeSession({
        provider: {
          id: "native-test",
          label: "Native Test",
          isConfigured: () => true,
          createBridge: (next) => {
            request = next;
            return makeBridge();
          },
        },
        providerConfig: {},
        audioSink: { sendAudio: vi.fn() },
        onError,
        handleDelegationInput: (_text, respond) => {
          if (replied) {
            respond("accepted");
          }
          throw new Error("callback failed");
        },
      });
      const respond = vi.fn();
      try {
        expect(request.handleDelegationInput?.("status", respond)).toBe("control");
        expect(respond).toHaveBeenCalledOnce();
        expect(respond.mock.calls[0]?.[0]).toContain(replied ? "accepted" : "Please try again.");
        expect(onError).toHaveBeenCalledExactlyOnceWith(new Error("callback failed"));
      } finally {
        session.close();
      }
    },
  );
});
