// Outbound dead-letter health tests cover bounded categories and privacy.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertDeliveryQueueEntry } from "../delivery-queue-sqlite.js";
import { resolvePreferredOpenClawTmpDir } from "../tmp-openclaw-dir.js";
import {
  summarizeOutboundFailedDeliveryQueueEntries,
  type OutboundDeliveryQueueCategory,
  type OutboundDeliveryRecoveryCategory,
} from "./delivery-queue-health.js";
import {
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";

describe("summarizeOutboundFailedDeliveryQueueEntries", () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-dq-health-"));
    stateDir = path.join(tmpDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    vi.useFakeTimers();
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

  it("maps every outbound namespace and closed recovery category", () => {
    fail({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      id: "prepared",
      failedAt: 1_000,
      channel: "telegram",
      recoveryState: "producer_claimed",
    });
    fail({
      queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
      id: "preparation-current",
      failedAt: 2_000,
      channel: "discord",
      recoveryState: "send_attempt_started",
    });
    fail({
      queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
      id: "preparation-legacy",
      failedAt: 3_000,
      channel: "discord",
      recoveryState: "send_attempt_started",
    });
    fail({
      queueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
      id: "migration",
      failedAt: 4_000,
      recoveryState: "unknown_after_send",
    });
    fail({
      queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      id: "legacy",
      failedAt: 5_000,
      channel: "x".repeat(65),
      recoveryState: "future_private_state",
    });
    fail({
      queueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
      id: "media",
      failedAt: 6_000,
      channel: "signal",
    });

    const summary = summarizeOutboundFailedDeliveryQueueEntries(stateDir);

    expect(summary).toMatchObject({ count: 6, oldestFailedAt: 1_000, newestFailedAt: 6_000 });
    expect(new Set(summary?.buckets.map((bucket) => bucket.queue))).toEqual(
      new Set<OutboundDeliveryQueueCategory>([
        "prepared",
        "preparation",
        "migration",
        "legacy",
        "mediaStaging",
      ]),
    );
    expect(new Set(summary?.buckets.map((bucket) => bucket.recoveryState))).toEqual(
      new Set<OutboundDeliveryRecoveryCategory>([
        "none",
        "producerClaimed",
        "sendAttemptStarted",
        "unknownAfterSend",
        "other",
      ]),
    );
    expect(summary?.buckets).toContainEqual({
      queue: "preparation",
      channel: "discord",
      recoveryState: "sendAttemptStarted",
      count: 2,
      oldestFailedAt: 2_000,
      newestFailedAt: 3_000,
    });
    expect(summary?.buckets.some((bucket) => bucket.channel === "[missing]")).toBe(true);
    expect(summary?.buckets.some((bucket) => bucket.channel === "[other]")).toBe(true);
  });

  it("never serializes sensitive row or payload fields", () => {
    const secrets = {
      id: "private-id-canary",
      sessionKey: "private-session-canary",
      accountId: "private-account-canary",
      target: "private-target-canary",
      error: "private-error-canary",
      body: "private-body-canary",
      recoveryState: "private-recovery-canary",
    };
    vi.setSystemTime(7_000);
    const entry = {
      id: secrets.id,
      enqueuedAt: 6_900,
      retryCount: 2,
      lastError: secrets.error,
      recoveryState: secrets.recoveryState,
      body: secrets.body,
    };
    upsertDeliveryQueueEntry({
      queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
      entry,
      metadata: {
        sessionKey: secrets.sessionKey,
        channel: "telegram",
        target: secrets.target,
        accountId: secrets.accountId,
      },
      status: "failed",
      stateDir,
    });

    const serialized = JSON.stringify(summarizeOutboundFailedDeliveryQueueEntries(stateDir));

    for (const secret of Object.values(secrets)) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('"recoveryState":"other"');
  });

  it("omits partial data when the fixed group bound is exceeded", () => {
    for (let index = 0; index <= 50; index += 1) {
      fail({
        queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
        id: `dead-${index}`,
        failedAt: 10_000 + index,
        channel: `channel-${index}`,
      });
    }

    expect(() => summarizeOutboundFailedDeliveryQueueEntries(stateDir)).toThrow(
      "outbound dead-letter health breakdown exceeded its fixed group bound",
    );
  });
});
