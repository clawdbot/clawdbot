import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type RawEvent = { id: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

describe("channel ingress monitor admission", () => {
  it("reports whether each durable admission inserted a new row", async () => {
    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      accountId: "a",
      stateDir: tempDirs.make("openclaw-ingress-monitor-admission-"),
    });
    const admissions: boolean[] = [];
    const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue,
      inspect: (raw) => ({ eventId: raw.id, laneKey: "lane:a" }),
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body) as RawEvent,
        createClaimError: (kind) => new Error(kind),
      },
      deliver: vi.fn(),
      pollIntervalMs: 10,
      retention: { pruneIntervalMs: 60_000 },
      onDurableAdmission: (_raw, { isNew }) => {
        admissions.push(isNew);
      },
    });

    try {
      await monitor.admit({ id: "event-one", text: "hello" });
      await monitor.admit({ id: "event-one", text: "hello" });
      expect(admissions).toEqual([true, false]);
    } finally {
      await monitor.stop();
    }
  });
});
