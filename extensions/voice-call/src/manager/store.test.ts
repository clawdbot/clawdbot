// Voice Call tests cover store plugin behavior.
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateSyncKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerVoiceCallLogs } from "../cli-call-log.js";
import {
  createTestStorePath,
  makePersistedCall,
  writeLegacyCallsJsonl,
} from "../manager.test-harness.js";
import { setVoiceCallStateRuntime } from "../runtime-state.js";
import { CallRecordSchema } from "../types.js";
import { MAX_CALL_REPLAY_KEYS } from "./replay-keys.js";
import {
  CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
  CALL_RECORD_CHUNK_MAX_ENTRIES,
  findCallInStore,
  getCallHistoryFromStore,
  loadActiveCallsFromStore,
  persistCallRecord,
} from "./store.js";

const { sleepMock } = vi.hoisted(() => ({ sleepMock: vi.fn() }));
vi.mock("../../api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api.js")>()),
  sleep: sleepMock,
}));

const MANAGER_REPLAY_KEY_LIMIT = 10_000;

function installStateRuntime(bulkReads = true): void {
  setVoiceCallStateRuntime({
    state: {
      resolveStateDir: () => "",
      openKeyedStore: (() => {
        throw new Error("openKeyedStore is not used by voice-call store tests");
      }) as never,
      openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) => {
        const store = createPluginStateSyncKeyedStoreForTests<T>("voice-call", options);
        if (bulkReads) {
          return store;
        }
        const { lookupMany: _lookupMany, ...legacy } = store;
        return legacy;
      },
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

  it.each([0, 1])("honors SQLite tail --since %s before following new snapshots", async (since) => {
    const storePath = createTestStorePath();
    const calls = ["first", "second", "third"].map((callId) =>
      CallRecordSchema.parse(makePersistedCall({ callId })),
    );
    const added = CallRecordSchema.parse(makePersistedCall({ callId: "new" }));
    for (const call of calls) {
      persistCallRecord(storePath, call);
    }
    const stopped = new Error("SQLite tail test finished");
    sleepMock
      .mockReset()
      .mockRejectedValue(stopped)
      .mockImplementationOnce(async () => {
        persistCallRecord(storePath, added);
      });
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const program = new Command();
    registerVoiceCallLogs({
      root: program,
      defaultFile: path.join(storePath, "calls.jsonl"),
      ensureHistoryStateRuntime: installStateRuntime,
    });
    try {
      await expect(
        program.parseAsync(["tail", "--since", String(since)], { from: "user" }),
      ).rejects.toBe(stopped);
      expect(
        output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).callId),
      ).toEqual(since === 0 ? ["new"] : ["third", "new"]);
    } finally {
      stdout.mockRestore();
      fs.rmSync(storePath, { recursive: true, force: true });
    }
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

  it.each([true, false])(
    "restores complete chunked call transcripts (bulk: %s)",
    async (bulkReads) => {
      installStateRuntime(bulkReads);
      const storePath = createTestStorePath();
      const call = CallRecordSchema.parse(
        makePersistedCall({
          callId: "call-chunked",
          transcript: [
            { timestamp: Date.now(), speaker: "user", text: "🦞".repeat(180_000), isFinal: true },
          ],
        }),
      );
      persistCallRecord(storePath, call);
      resetPluginStateStoreForTests();
      expect(loadActiveCallsFromStore(storePath).activeCalls.get(call.callId)?.transcript).toEqual(
        call.transcript,
      );
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([call]);
      const env = { ...process.env, OPENCLAW_STATE_DIR: storePath };
      const chunks = createPluginStateSyncKeyedStoreForTests<{ index: number; dataBase64: string }>(
        "voice-call",
        {
          namespace: CALL_RECORD_EVENT_CHUNKS_NAMESPACE,
          maxEntries: CALL_RECORD_CHUNK_MAX_ENTRIES,
          env,
        },
      );
      const rows = chunks.entries();
      const first = rows.find((row) => row.value.index === 0);
      const later = rows.find((row) => row.value.index === 1);
      if (!first || !later) {
        throw new Error("expected call transcript chunks");
      }
      const good = CallRecordSchema.parse(
        makePersistedCall({ callId: "good-call", transcript: [] }),
      );
      persistCallRecord(storePath, good);
      const { db } = openOpenClawStateDatabase({ env });
      db.prepare("UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = ?").run(
        "invalid JSON",
        later.key,
      );
      chunks.register(first.key, { ...first.value, index: -1 });
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([good]);
      expect(findCallInStore(storePath, good.callId)).toEqual(good);
      chunks.delete(first.key);
      await expect(getCallHistoryFromStore(storePath)).resolves.toEqual([good]);
      chunks.register(first.key, first.value);
      expect(() => findCallInStore(storePath, good.callId)).toThrowError(
        expect.objectContaining({ code: "PLUGIN_STATE_CORRUPT" }),
      );
    },
  );

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
    expect(findCallInStore(storePath, "call-target")).toMatchObject({
      callId: "call-target",
      state: "completed",
    });
    expect(findCallInStore(storePath, "provider-target")).toMatchObject({
      callId: "call-target",
      state: "completed",
    });
  });
});
