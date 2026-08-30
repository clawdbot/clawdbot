// Voice Call tests cover store plugin behavior.
import fs from "node:fs";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestStorePath,
  makePersistedCall,
  writeLegacyCallsJsonl,
} from "../manager.test-harness.js";
import { setVoiceCallStateRuntime } from "../runtime-state.js";
import { CallRecordSchema } from "../types.js";
import { MAX_CALL_REPLAY_KEYS } from "./replay-keys.js";
import {
  CALL_RECORD_CHUNK_MAX_ENTRIES,
  CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
  CALL_RECORD_EVENT_META_MAX_ENTRIES,
  CALL_RECORD_EVENTS_NAMESPACE,
  findCallMatchesInStore,
  getCallHistoryFromStore,
  loadActiveCallsFromStore,
  MAX_CALL_RECORD_EVENTS,
  persistCallRecord,
} from "./store.js";

const MANAGER_REPLAY_KEY_LIMIT = 10_000;

function installStateRuntime(): void {
  setVoiceCallStateRuntime({
    state: {
      resolveStateDir: () => "",
      openKeyedStore: (() => {
        throw new Error("openKeyedStore is not used by voice-call store tests");
      }) as never,
      openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStoreForTests("voice-call", options),
      openChannelIngressQueue: (() => {
        throw new Error("openChannelIngressQueue is not used by voice-call store tests");
      }) as never,
      openChannelIngressDrain: (() => {
        throw new Error("openChannelIngressDrain is not used by voice-call store tests");
      }) as never,
    },
  });
}

describe("voice-call call record store", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    installStateRuntime();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetPluginStateStoreForTests();
  });

  it("does not import legacy JSONL records at runtime", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-legacy", processedEventIds: ["evt-1"] }),
    );
    writeLegacyCallsJsonl(storePath, [call]);

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.has("call-legacy")).toBe(false);
    expect(restored.processedEventIds.has("evt-1")).toBe(false);
    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(true);

    const history = await getCallHistoryFromStore(storePath);
    expect(history).toEqual([]);
  });

  it("persists new call snapshots without recreating the JSONL log", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-sqlite", transcript: [] }),
    );

    persistCallRecord(storePath, call);

    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(false);
    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.get("call-sqlite")?.providerCallId).toBe(call.providerCallId);
  });

  it("does not read the JSONL fallback when SQLite state cannot open", () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(makePersistedCall({ callId: "call-jsonl" }));
    writeLegacyCallsJsonl(storePath, [call]);
    setVoiceCallStateRuntime({
      state: {
        resolveStateDir: () => "",
        openKeyedStore: (() => {
          throw new Error("openKeyedStore is not used by voice-call store tests");
        }) as never,
        openSyncKeyedStore: (() => {
          throw new Error("sqlite unavailable");
        }) as never,
        openChannelIngressQueue: (() => {
          throw new Error("openChannelIngressQueue is not used by voice-call store tests");
        }) as never,
        openChannelIngressDrain: (() => {
          throw new Error("openChannelIngressDrain is not used by voice-call store tests");
        }) as never,
      },
    });

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.has("call-jsonl")).toBe(false);
    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(true);
  });

  it("persists oversized records in SQLite without creating a JSONL fallback", async () => {
    const storePath = createTestStorePath();
    const call = CallRecordSchema.parse(
      makePersistedCall({
        callId: "call-large",
        metadata: { mode: "conversation", numberRouteKey: "+15550000001" },
        transcript: [
          {
            timestamp: Date.now(),
            speaker: "user",
            text: "x".repeat(3 * 1024 * 1024),
            isFinal: true,
          },
        ],
      }),
    );

    persistCallRecord(storePath, call);

    const restored = loadActiveCallsFromStore(storePath);
    const restoredCall = restored.activeCalls.get("call-large");
    expect(restoredCall?.providerCallId).toBe(call.providerCallId);
    expect(restoredCall?.transcript).toEqual([]);
    expect(restoredCall?.metadata).toMatchObject({
      mode: "conversation",
      numberRouteKey: "+15550000001",
      voiceCallPersistence: { transcriptTruncated: true },
    });
    expect(fs.existsSync(path.join(storePath, "calls.jsonl"))).toBe(false);
  });

  it("leaves no chunk rows without metadata when persistence is interrupted", () => {
    const storePath = createTestStorePath();
    const env = { ...process.env, OPENCLAW_STATE_DIR: storePath };
    persistCallRecord(
      storePath,
      CallRecordSchema.parse(makePersistedCall({ callId: "call-interrupted", state: "ringing" })),
    );
    setVoiceCallStateRuntime({
      state: {
        resolveStateDir: () => "",
        openKeyedStore: (() => {
          throw new Error("openKeyedStore is not used by voice-call store tests");
        }) as never,
        openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) => {
          const store = createPluginStateSyncKeyedStoreForTests<T>("voice-call", options);
          if (options.namespace !== CALL_RECORD_EVENTS_NAMESPACE) {
            return store;
          }
          return {
            ...store,
            register: () => {
              throw new Error("simulated interruption");
            },
          };
        },
        openChannelIngressQueue: (() => {
          throw new Error("openChannelIngressQueue is not used by voice-call store tests");
        }) as never,
        openChannelIngressDrain: (() => {
          throw new Error("openChannelIngressDrain is not used by voice-call store tests");
        }) as never,
      },
    });
    expect(() =>
      persistCallRecord(
        storePath,
        CallRecordSchema.parse(
          makePersistedCall({ callId: "call-interrupted", state: "answered" }),
        ),
      ),
    ).toThrow("simulated interruption");

    installStateRuntime();
    const events = createPluginStateSyncKeyedStoreForTests<{ chunkCount: number }>("voice-call", {
      namespace: CALL_RECORD_EVENTS_NAMESPACE,
      maxEntries: CALL_RECORD_EVENT_META_MAX_ENTRIES,
      env,
    });
    const chunks = createPluginStateSyncKeyedStoreForTests<{ index: number }>("voice-call", {
      namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
      maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
      env,
    });
    const orphanEventKeys = chunks
      .entries()
      .map((entry) => entry.key.replace(/:chunk:\d+$/, ""))
      .filter((eventKey) => events.lookup(eventKey) === undefined);
    expect(orphanEventKeys).toEqual([]);

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.get("call-interrupted")?.state).toBe("ringing");
  });

  it("keeps retained snapshots and rolls back rows when a persist fails", async () => {
    const storePath = createTestStorePath();
    const env = { ...process.env, OPENCLAW_STATE_DIR: storePath };
    const events = createPluginStateSyncKeyedStoreForTests<Record<string, unknown>>("voice-call", {
      namespace: CALL_RECORD_EVENTS_NAMESPACE,
      maxEntries: CALL_RECORD_EVENT_META_MAX_ENTRIES,
      env,
    });
    const chunks = createPluginStateSyncKeyedStoreForTests<Record<string, unknown>>("voice-call", {
      namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
      maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
      env,
    });
    for (let index = 0; index <= MAX_CALL_RECORD_EVENTS; index += 1) {
      const key = `event:seed:${String(index).padStart(6, "0")}:seeded`;
      const serialized = JSON.stringify(
        CallRecordSchema.parse(makePersistedCall({ callId: `call-seed-${index}` })),
      );
      events.register(key, {
        chunkCount: 1,
        byteLength: Buffer.byteLength(serialized, "utf8"),
        persistedAt: index,
        sequence: index % 1_000_000,
      });
      chunks.register(`${key}:chunk:0000`, {
        index: 0,
        dataBase64: Buffer.from(serialized, "utf8").toString("base64"),
      });
    }
    setVoiceCallStateRuntime({
      state: {
        resolveStateDir: () => "",
        openKeyedStore: (() => {
          throw new Error("openKeyedStore is not used by voice-call store tests");
        }) as never,
        openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) => {
          const store = createPluginStateSyncKeyedStoreForTests<T>("voice-call", options);
          if (options.namespace !== CALL_RECORD_EVENT_CHUNKS_NAMESPACE) {
            return store;
          }
          return {
            ...store,
            register: () => {
              throw new Error("simulated write failure");
            },
          };
        },
        openChannelIngressQueue: (() => {
          throw new Error("openChannelIngressQueue is not used by voice-call store tests");
        }) as never,
        openChannelIngressDrain: (() => {
          throw new Error("openChannelIngressDrain is not used by voice-call store tests");
        }) as never,
      },
    });
    expect(() =>
      persistCallRecord(
        storePath,
        CallRecordSchema.parse(makePersistedCall({ callId: "call-fail" })),
      ),
    ).toThrow("simulated write failure");

    installStateRuntime();
    expect(events.entries()).toHaveLength(MAX_CALL_RECORD_EVENTS + 1);
    const history = await getCallHistoryFromStore(storePath, MAX_CALL_RECORD_EVENTS + 10);
    expect(history.some((call) => call.callId === "call-seed-0")).toBe(true);
    expect(history.some((call) => call.callId === "call-fail")).toBe(false);
  });

  it("removes stranded partial records on restore", () => {
    const storePath = createTestStorePath();
    const env = { ...process.env, OPENCLAW_STATE_DIR: storePath };
    persistCallRecord(
      storePath,
      CallRecordSchema.parse(makePersistedCall({ callId: "call-keep", state: "ringing" })),
    );
    const events = createPluginStateSyncKeyedStoreForTests<Record<string, unknown>>("voice-call", {
      namespace: CALL_RECORD_EVENTS_NAMESPACE,
      maxEntries: CALL_RECORD_EVENT_META_MAX_ENTRIES,
      env,
    });
    const chunks = createPluginStateSyncKeyedStoreForTests<Record<string, unknown>>("voice-call", {
      namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
      maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
      env,
    });
    chunks.register("event:legacy:000001:orphan:chunk:0000", { index: 0, dataBase64: "e30=" });
    events.register("event:partial:000002:dangling", {
      chunkCount: 2,
      byteLength: 4,
      persistedAt: 1,
      sequence: 2,
    });
    chunks.register("event:partial:000002:dangling:chunk:0000", { index: 0, dataBase64: "e30=" });

    const restored = loadActiveCallsFromStore(storePath);

    expect(restored.activeCalls.get("call-keep")?.state).toBe("ringing");
    const survivingEvents = events.entries();
    const survivingChunks = chunks.entries();
    expect(survivingEvents).toHaveLength(1);
    expect(survivingChunks).toHaveLength(1);
    expect(survivingChunks[0]?.key).toBe(`${survivingEvents[0]?.key}:chunk:0000`);
  });

  it("replays same-millisecond snapshots in write order", () => {
    vi.useFakeTimers({ now: new Date("2026-05-31T10:00:00.000Z") });
    const storePath = createTestStorePath();
    const first = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-order", state: "ringing" }),
    );
    const second = CallRecordSchema.parse(
      makePersistedCall({ callId: "call-order", state: "answered" }),
    );

    persistCallRecord(storePath, first);
    persistCallRecord(storePath, second);

    const restored = loadActiveCallsFromStore(storePath);
    expect(restored.activeCalls.get("call-order")?.state).toBe("answered");
  });

  it("persists and restores only the newest per-call replay keys", () => {
    const storePath = createTestStorePath();
    const replayKeys = Array.from(
      { length: MAX_CALL_REPLAY_KEYS + 2 },
      (_, index) => `evt-${index}`,
    );
    const call = CallRecordSchema.parse(
      makePersistedCall({
        callId: "call-bounded-replay",
        processedEventIds: replayKeys,
      }),
    );

    persistCallRecord(storePath, call);

    const restored = loadActiveCallsFromStore(storePath);
    const expected = replayKeys.slice(-MAX_CALL_REPLAY_KEYS);
    expect(restored.activeCalls.get("call-bounded-replay")?.processedEventIds).toEqual(expected);
    expect([...restored.processedEventIds]).toEqual(expected);
  });

  it("hydrates manager replay keys in latest-snapshot call order", () => {
    const storePath = createTestStorePath();
    persistCallRecord(
      storePath,
      CallRecordSchema.parse(
        makePersistedCall({
          callId: "call-latest",
          providerCallId: "provider-latest",
          processedEventIds: ["evt-latest-old"],
        }),
      ),
    );
    for (
      let callIndex = 0;
      callIndex < MANAGER_REPLAY_KEY_LIMIT / MAX_CALL_REPLAY_KEYS;
      callIndex++
    ) {
      persistCallRecord(
        storePath,
        CallRecordSchema.parse(
          makePersistedCall({
            callId: `call-fill-${callIndex}`,
            providerCallId: `provider-fill-${callIndex}`,
            processedEventIds: Array.from(
              { length: MAX_CALL_REPLAY_KEYS },
              (_, eventIndex) => `evt-fill-${callIndex}-${eventIndex}`,
            ),
          }),
        ),
      );
    }
    persistCallRecord(
      storePath,
      CallRecordSchema.parse(
        makePersistedCall({
          callId: "call-latest",
          providerCallId: "provider-latest",
          processedEventIds: ["evt-latest-old", "evt-latest-new"],
        }),
      ),
    );

    const restored = loadActiveCallsFromStore(storePath);

    expect(restored.processedEventIds.size).toBe(MANAGER_REPLAY_KEY_LIMIT);
    expect(restored.processedEventIds.has("evt-latest-old")).toBe(true);
    expect(restored.processedEventIds.has("evt-latest-new")).toBe(true);
    expect(restored.processedEventIds.has("evt-fill-0-0")).toBe(false);
    expect(restored.processedEventIds.has("evt-fill-0-1")).toBe(false);
  });

  it("finds retained snapshots outside recent history and preserves internal-id precedence", async () => {
    const storePath = createTestStorePath();
    persistCallRecord(
      storePath,
      CallRecordSchema.parse(
        makePersistedCall({ callId: "call-target", providerCallId: "provider-target" }),
      ),
    );
    persistCallRecord(
      storePath,
      CallRecordSchema.parse(
        makePersistedCall({
          callId: "call-target",
          providerCallId: "provider-target",
          state: "completed",
        }),
      ),
    );
    for (let index = 0; index < 101; index += 1) {
      persistCallRecord(
        storePath,
        CallRecordSchema.parse(
          makePersistedCall({
            callId: `noise-${index}`,
            providerCallId: index === 100 ? "call-target" : `provider-noise-${index}`,
          }),
        ),
      );
    }
    expect(await getCallHistoryFromStore(storePath, 100)).toHaveLength(100);
    const internalMatches = await findCallMatchesInStore(storePath, "call-target");
    expect(internalMatches.byCallId).toMatchObject({
      callId: "call-target",
      state: "completed",
    });
    expect(internalMatches.byProviderCallId).toMatchObject({ callId: "noise-100" });

    const providerMatches = await findCallMatchesInStore(storePath, "provider-target");
    expect(providerMatches.byProviderCallId).toMatchObject({
      callId: "call-target",
      state: "completed",
    });
  });
});
