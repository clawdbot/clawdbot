import { describe, expect, it, vi } from "vitest";
import {
  classifyOutboundSendFailure,
  createDeliveryRecoveryCoordinator,
  isDeliveryRecoveryRetryEligible,
  resolveDeliveryRecoveryDeadlineMs,
} from "./delivery-recovery.shared.js";
import { PlatformMessageNotDispatchedError } from "./outbound/deliver-types.js";

type RecoveryTestEntry = {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  availableAt?: number;
};

function createEntry(id: string, enqueuedAt: number): RecoveryTestEntry {
  return { id, enqueuedAt, retryCount: 0 };
}

describe("shared durable delivery recovery coordinator", () => {
  it("shares active claims between live delivery and recovery scans", async () => {
    const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>();
    const entry = createEntry("live-owner", 1);
    const loadEntry = vi.fn(async () => entry);
    const onEntry = vi.fn(async () => undefined);
    const onClaimConflict = vi.fn();
    let releaseLiveDelivery!: () => void;
    const liveDelivery = coordinator.withClaim(
      entry.id,
      () =>
        new Promise<void>((resolve) => {
          releaseLiveDelivery = resolve;
        }),
    );

    await coordinator.scan({ entries: [entry], loadEntry, onEntry, onClaimConflict });

    expect(onClaimConflict).toHaveBeenCalledWith(entry);
    expect(loadEntry).not.toHaveBeenCalled();
    expect(onEntry).not.toHaveBeenCalled();

    releaseLiveDelivery();
    await expect(liveDelivery).resolves.toEqual({ status: "claimed", value: undefined });
    await coordinator.scan({ entries: [entry], loadEntry, onEntry });
    expect(onEntry).toHaveBeenCalledWith(entry);
  });

  it("releases an active claim when its owner throws", async () => {
    const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>();

    await expect(
      coordinator.withClaim("failed-owner", async () => {
        throw new Error("provider failed");
      }),
    ).rejects.toThrow("provider failed");

    await expect(coordinator.withClaim("failed-owner", async () => "recovered")).resolves.toEqual({
      status: "claimed",
      value: "recovered",
    });
  });

  it("excludes concurrent same-key drains and releases failed drains", async () => {
    const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>();
    let releaseDrain!: () => void;
    const first = coordinator.withDrain(
      "account:demo",
      () =>
        new Promise<void>((resolve) => {
          releaseDrain = resolve;
        }),
    );

    await expect(coordinator.withDrain("account:demo", async () => undefined)).resolves.toBe(false);
    releaseDrain();
    await expect(first).resolves.toBe(true);

    await expect(
      coordinator.withDrain("account:demo", async () => {
        throw new Error("scan interrupted");
      }),
    ).rejects.toThrow("scan interrupted");
    await expect(coordinator.withDrain("account:demo", async () => undefined)).resolves.toBe(true);
  });

  it("sorts snapshots and reloads authoritative entries before processing", async () => {
    const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>();
    const first = createEntry("first", 1);
    const missing = createEntry("missing", 2);
    const last = createEntry("last", 3);
    const authoritativeFirst = { ...first, retryCount: 2 };
    const pending = new Map([
      [first.id, authoritativeFirst],
      [last.id, last],
    ]);
    const processed: RecoveryTestEntry[] = [];
    const onMissingEntry = vi.fn();

    await coordinator.scan({
      entries: [last, missing, first],
      loadEntry: async (id) => pending.get(id) ?? null,
      onMissingEntry,
      onEntry: async (entry) => {
        processed.push(entry);
      },
    });

    expect(processed).toEqual([authoritativeFirst, last]);
    expect(onMissingEntry).toHaveBeenCalledWith(missing);
  });

  it("stops after an owner reports that its replay budget was exhausted", async () => {
    const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>();
    const entries = [createEntry("first", 1), createEntry("remaining", 2)];
    const onEntry = vi.fn(async () => "stop" as const);

    await coordinator.scan({
      entries,
      loadEntry: async (id) => entries.find((entry) => entry.id === id) ?? null,
      onEntry,
    });

    expect(onEntry).toHaveBeenCalledTimes(1);
    expect(onEntry).toHaveBeenCalledWith(entries[0]);
  });

  it("defers expired recovery without claiming or reloading a pending entry", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
      const coordinator = createDeliveryRecoveryCoordinator<RecoveryTestEntry>();
      const entry = createEntry("deadline", Date.now());
      const loadEntry = vi.fn(async () => entry);
      const onEntry = vi.fn(async () => undefined);
      const onDeadlineExceeded = vi.fn();

      await coordinator.scan({
        entries: [entry],
        loadEntry,
        onEntry,
        deadlineMs: Date.now(),
        onDeadlineExceeded,
      });

      expect(onDeadlineExceeded).toHaveBeenCalledOnce();
      expect(loadEntry).not.toHaveBeenCalled();
      expect(onEntry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors initial delivery leases and canonical retry backoff", () => {
    const now = 100_000;
    expect(
      isDeliveryRecoveryRetryEligible(
        { ...createEntry("leased", now), availableAt: now + 250 },
        now,
      ),
    ).toEqual({ eligible: false, remainingBackoffMs: 250 });
    expect(isDeliveryRecoveryRetryEligible(createEntry("fresh", now), now)).toEqual({
      eligible: true,
    });
    expect(
      isDeliveryRecoveryRetryEligible(
        { ...createEntry("retry", now - 2_000), retryCount: 1, lastAttemptAt: now - 2_000 },
        now,
      ),
    ).toEqual({ eligible: false, remainingBackoffMs: 3_000 });
  });

  it("normalizes recovery deadlines without widening negative or invalid budgets", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
      const now = Date.now();
      expect(resolveDeliveryRecoveryDeadlineMs(-1)).toBe(now);
      expect(resolveDeliveryRecoveryDeadlineMs(5_000.9)).toBe(now + 5_000);
      expect(resolveDeliveryRecoveryDeadlineMs(Number.NaN)).toBe(now + 60_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

function errnoError(message: string, code: string, syscall?: string): Error {
  return Object.assign(new Error(message), { code, ...(syscall ? { syscall } : {}) });
}

describe("classifyOutboundSendFailure", () => {
  it.each([
    ["connect refusal", errnoError("connect ECONNREFUSED 10.0.0.1:443", "ECONNREFUSED", "connect")],
    ["dns not found", errnoError("getaddrinfo ENOTFOUND api.example", "ENOTFOUND", "getaddrinfo")],
    ["dns backoff", errnoError("getaddrinfo EAI_AGAIN api.example", "EAI_AGAIN", "getaddrinfo")],
    ["connect timeout", errnoError("connect ETIMEDOUT 10.0.0.1:443", "ETIMEDOUT", "connect")],
    ["undici connect timeout", errnoError("Connect Timeout Error", "UND_ERR_CONNECT_TIMEOUT")],
    [
      "tls hostname mismatch",
      errnoError("Hostname/IP does not match", "ERR_TLS_CERT_ALTNAME_INVALID"),
    ],
    ["tls expired certificate", errnoError("certificate has expired", "CERT_HAS_EXPIRED")],
    [
      "provider no-send marker",
      new PlatformMessageNotDispatchedError("request not started", { cause: new Error("x") }),
    ],
    [
      "nested connect refusal",
      new Error("send failed", {
        cause: errnoError("connect ECONNREFUSED 10.0.0.1:443", "ECONNREFUSED", "connect"),
      }),
    ],
  ])("classifies %s as provably not sent and retryable", (_label, error) => {
    expect(classifyOutboundSendFailure(error)).toEqual({
      kind: "provably_not_sent",
      retryable: true,
    });
  });

  it("classifies platform 5xx and 429 responses as retryable, honoring retry_after", () => {
    expect(
      classifyOutboundSendFailure(
        Object.assign(new Error("500: Internal Server Error"), {
          error_code: 500,
          description: "Internal Server Error",
        }),
      ),
    ).toEqual({ kind: "provably_not_sent", retryable: true });
    expect(
      classifyOutboundSendFailure(
        Object.assign(new Error("429: Too Many Requests: retry after 5"), {
          error_code: 429,
          description: "Too Many Requests: retry after 5",
          parameters: { retry_after: 5 },
        }),
      ),
    ).toEqual({ kind: "provably_not_sent", retryable: true, retryAfterMs: 5_000 });
  });

  it.each([
    [
      "platform semantic 400",
      Object.assign(new Error("400: Bad Request: chat not found"), {
        error_code: 400,
        description: "Bad Request: chat not found",
      }),
    ],
    [
      "http client 404 response",
      Object.assign(new Error("Not Found"), { status: 404, body: "{}" }),
    ],
    [
      "provider permanent rejection marker",
      new PlatformMessageNotDispatchedError("rejected payload", {
        cause: new Error("x"),
        retryable: false,
      }),
    ],
  ])("classifies %s as provably not sent but terminal", (_label, error) => {
    expect(classifyOutboundSendFailure(error)).toEqual({
      kind: "provably_not_sent",
      retryable: false,
    });
  });

  it.each([
    ["socket reset after write", errnoError("read ECONNRESET", "ECONNRESET", "read")],
    ["non-connect timeout", errnoError("ETIMEDOUT", "ETIMEDOUT", "read")],
    ["bare timeout code", errnoError("timed out", "ETIMEDOUT")],
    ["plain error", new Error("boom")],
    ["socket hang up", errnoError("socket hang up", "ECONNRESET")],
    // A bare status number without response evidence is not a platform reply.
    ["status without response evidence", Object.assign(new Error("failed"), { status: 500 })],
  ])("keeps %s ambiguous", (_label, error) => {
    expect(classifyOutboundSendFailure(error)).toEqual({ kind: "ambiguous" });
  });
});
