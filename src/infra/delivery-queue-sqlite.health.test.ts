// Delivery queue health storage tests cover metadata-only grouping and bounds.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countFailedDeliveryQueueEntriesByMetadata,
  upsertDeliveryQueueEntry,
} from "./delivery-queue-sqlite.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

describe("countFailedDeliveryQueueEntriesByMetadata", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-meta-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function fail(params: {
    queueName: string;
    id: string;
    failedAt: number;
    channel?: string;
    recoveryState?: string;
  }) {
    vi.setSystemTime(params.failedAt);
    upsertDeliveryQueueEntry({
      queueName: params.queueName,
      entry: {
        id: params.id,
        enqueuedAt: params.failedAt - 100,
        retryCount: 1,
        ...(params.recoveryState ? { recoveryState: params.recoveryState } : {}),
      },
      metadata: { channel: params.channel },
      status: "failed",
      stateDir,
    });
  }

  it("groups only selected failed queues and returns both failure boundaries", () => {
    vi.useFakeTimers();
    fail({ queueName: "outbound-prepared-v1", id: "one", failedAt: 1_000, channel: "telegram" });
    fail({ queueName: "outbound-prepared-v1", id: "two", failedAt: 2_000, channel: "telegram" });
    fail({
      queueName: "outbound-preparing-v1",
      id: "three",
      failedAt: 3_000,
      channel: "discord",
      recoveryState: "unknown_after_send",
    });
    fail({ queueName: "session", id: "excluded", failedAt: 4_000, channel: "telegram" });
    upsertDeliveryQueueEntry({
      queueName: "outbound-prepared-v1",
      entry: { id: "pending", enqueuedAt: 5_000, retryCount: 0 },
      metadata: { channel: "telegram" },
      stateDir,
    });

    expect(
      countFailedDeliveryQueueEntriesByMetadata({
        queueNames: ["outbound-prepared-v1", "outbound-preparing-v1"],
        maxGroups: 10,
        stateDir,
      }),
    ).toEqual({
      truncated: false,
      groups: [
        {
          queueName: "outbound-prepared-v1",
          channel: "telegram",
          recoveryState: null,
          count: 2,
          oldestFailedAt: 1_000,
          newestFailedAt: 2_000,
        },
        {
          queueName: "outbound-preparing-v1",
          channel: "discord",
          recoveryState: "unknown_after_send",
          count: 1,
          oldestFailedAt: 3_000,
          newestFailedAt: 3_000,
        },
      ],
    });
  });

  it("fails closed instead of returning a partial breakdown", () => {
    vi.useFakeTimers();
    fail({ queueName: "outbound", id: "one", failedAt: 1_000, channel: "telegram" });
    fail({ queueName: "outbound", id: "two", failedAt: 2_000, channel: "discord" });

    expect(
      countFailedDeliveryQueueEntriesByMetadata({
        queueNames: ["outbound"],
        maxGroups: 1,
        stateDir,
      }),
    ).toEqual({ truncated: true });
  });
});
