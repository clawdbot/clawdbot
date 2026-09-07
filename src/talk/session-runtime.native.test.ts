import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { resolvePluginCapabilityProvider } from "../plugins/capability-provider-runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
} from "../plugins/registry-resources.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { acquireConfiguredRealtimeVoiceProvider } from "./provider-resolver.js";
import type {
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceBridgeCallbacks,
  RealtimeVoiceBridge,
} from "./provider-types.js";
import {
  createRealtimeVoiceBridgeSession,
  type RealtimeVoiceBridgeSession,
} from "./session-runtime.js";
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

describe("Realtime voice resource lifetime", () => {
  it("binds lazy bridge lookups and retains native resources through accepted submission", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE events (name TEXT)");
    const registry = createEmptyPluginRegistry();
    const owner = createPluginRegistryResourceOwner(registry, "scoped");
    registerPluginRegistryResourceDisposer(registry, "bridge-native", {
      id: "bridge-native-db",
      dispose: () => db.close(),
    });
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    let request!: RealtimeVoiceBridgeCreateRequest;
    let acknowledge: (() => void) | undefined;
    let events: unknown[] = [];
    const useResource = (name: string) => {
      expect(
        resolvePluginCapabilityProvider({
          key: "realtimeVoiceProviders",
          providerId: "bridge-native",
        })?.id,
      ).toBe("bridge-native");
      db.prepare("INSERT INTO events (name) VALUES (?)").run(name);
    };
    const bridge: RealtimeVoiceBridge = {
      get supportsToolResultSuppression() {
        useResource("capability");
        return true;
      },
      async connect() {
        await Promise.resolve();
        useResource("connect");
      },
      sendAudio() {
        useResource("audio");
      },
      setMediaTimestamp() {
        useResource("timestamp");
      },
      sendUserMessage() {
        useResource("message");
      },
      triggerGreeting() {
        useResource("greeting");
      },
      handleBargeIn() {
        useResource("barge-in");
      },
      acknowledgeMark() {
        useResource("mark");
      },
      isConnected() {
        useResource("connected");
        return true;
      },
      async submitToolResult() {
        useResource("submit");
        entered.resolve();
        await finish.promise;
        useResource("submitted");
        events = db
          .prepare("SELECT name FROM events")
          .all()
          .map((row) => row.name);
      },
      close() {
        useResource("close");
      },
    };
    registry.realtimeVoiceProviders.push({
      pluginId: "bridge-native",
      source: "synthetic-native-fixture",
      provider: {
        id: "bridge-native",
        label: "Bridge native",
        isConfigured: () => true,
        createBridge(next) {
          request = next;
          return bridge;
        },
      },
    });
    let session: RealtimeVoiceBridgeSession | undefined;
    let pending: Promise<void> | undefined;
    const acquired = withPluginRuntimeRegistryScope(registry, () =>
      acquireConfiguredRealtimeVoiceProvider({
        configuredProviderId: "bridge-native",
        cfg: {},
      }),
    );
    try {
      await withPluginRuntimeRegistryScope(registry, async () => {
        const params = {
          provider: acquired.provider,
          providerConfig: {},
          runWithProviderResources: acquired.run,
          audioSink: {
            sendAudio() {},
            sendMark: (_name: string, callback?: () => void) => {
              acknowledge = callback;
            },
          },
        };
        session = createRealtimeVoiceBridgeSession(params);
        owner.release();
        await session.connect();
        session.sendAudio(Buffer.from([1, 2]));
        session.setMediaTimestamp(12);
        session.sendUserMessage("hello");
        session.triggerGreeting();
        session.handleBargeIn();
        session.acknowledgeMark("legacy");
        expect(session.bridge.isConnected()).toBe(true);
        request.onMark?.("delayed", () => useResource("acknowledged"));
        acknowledge?.();
        pending = Promise.resolve(session.submitToolResult("call", {}, { suppressResponse: true }));
        await entered.promise;
        session.close();
        acquired.release();
        expect(db.isOpen).toBe(true);
        // Late transport callbacks must remain no-ops after lease admission closes.
        acknowledge?.();
        session.acknowledgeMark("late");
        session.handleBargeIn();
        finish.resolve();
        await pending;
        expect(events).toEqual(
          expect.arrayContaining([
            "connect",
            "audio",
            "timestamp",
            "message",
            "greeting",
            "barge-in",
            "mark",
            "connected",
            "acknowledged",
            "capability",
            "submit",
            "close",
            "submitted",
          ]),
        );
        expect(events.filter((name) => name === "acknowledged")).toHaveLength(1);
        expect(events.filter((name) => name === "mark")).toHaveLength(1);
        expect(events.filter((name) => name === "barge-in")).toHaveLength(1);
      });
      await drainPluginRegistryResourceDisposals();
      expect(db.isOpen).toBe(false);
    } finally {
      finish.resolve();
      await pending?.catch(() => {});
      try {
        session?.close();
      } catch {
        // Preserve the primary regression failure when baseline cleanup also lacks its scope.
      } finally {
        acquired.release();
        owner.release();
        await drainPluginRegistryResourceDisposals();
        if (db.isOpen) {
          db.close();
        }
      }
    }
  });

  it("retries failed physical close without reopening input or recursing during close", async () => {
    let attempts = 0;
    let inputCount = 0;
    const session: RealtimeVoiceBridgeSession = createRealtimeVoiceBridgeSession({
      provider: {
        id: "retry-native",
        label: "Retry native",
        isConfigured: () => true,
        createBridge: () => ({
          async connect() {},
          sendAudio() {
            inputCount += 1;
          },
          setMediaTimestamp() {},
          acknowledgeMark() {},
          submitToolResult() {},
          isConnected: () => true,
          close() {
            attempts += 1;
            session.close();
            session.sendAudio(Buffer.from([1, 2]));
            if (attempts === 1) {
              throw new Error("provider close failed");
            }
          },
        }),
      },
      providerConfig: {},
      audioSink: { sendAudio() {} },
    });
    expect(() => session.close()).toThrow("provider close failed");
    await expect(session.connect()).rejects.toThrow("Realtime voice session is closed");
    session.sendAudio(Buffer.from([1, 2]));
    session.close();
    session.close();
    expect(attempts).toBe(2);
    expect(inputCount).toBe(0);
  });
});
