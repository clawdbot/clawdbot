import type {
  PluginStateEntry,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createSmsDeliveryRecorder,
  isTwilioDeliveryStatusForm,
  listRecentSmsDeliveryRecords,
  recordInitialSmsDeliveryResult,
  type SmsDeliveryRecord,
} from "./delivery-observations.js";
import { setSmsRuntime } from "./runtime.js";
import type { ResolvedSmsAccount } from "./types.js";

function createAccount(
  accountId = "default",
  overrides: Partial<ResolvedSmsAccount> = {},
): ResolvedSmsAccount {
  return {
    accountId,
    enabled: true,
    accountSid: "AC123",
    authToken: "secret",
    fromNumber: "+15557654321",
    messagingServiceSid: "",
    defaultTo: "",
    webhookPath: "/webhooks/sms",
    publicWebhookUrl: "https://gateway.example.com/webhooks/sms",
    dangerouslyDisableSignatureValidation: false,
    dmPolicy: "pairing",
    allowFrom: [],
    textChunkLimit: 1500,
    ...overrides,
  };
}

function createStore(): PluginStateKeyedStore<SmsDeliveryRecord> {
  const values = new Map<string, SmsDeliveryRecord>();
  return {
    async register(key, value) {
      values.set(key, value);
    },
    async registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    async update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (!next) {
        return false;
      }
      values.set(key, next);
      return true;
    },
    async deleteIf(key, predicate) {
      const value = values.get(key);
      if (!value || !predicate(value)) {
        return false;
      }
      return values.delete(key);
    },
    async lookup(key) {
      return values.get(key);
    },
    async consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    async delete(key) {
      return values.delete(key);
    },
    async entries() {
      return [...values.entries()].map(
        ([key, value]): PluginStateEntry<SmsDeliveryRecord> => ({
          key,
          value,
          createdAt: value.lastObservedAt,
        }),
      );
    },
    async clear() {
      values.clear();
    },
  };
}

async function latestRecord(
  store: PluginStateKeyedStore<SmsDeliveryRecord>,
): Promise<SmsDeliveryRecord> {
  const record = (await listRecentSmsDeliveryRecords(createAccount(), 1, store))[0];
  if (!record) {
    throw new Error("test invariant: expected an SMS delivery record");
  }
  return record;
}

async function recordApiStatus(
  store: PluginStateKeyedStore<SmsDeliveryRecord>,
  status: string,
  observedAt: number,
): Promise<SmsDeliveryRecord> {
  await recordInitialSmsDeliveryResult({
    account: createAccount(),
    result: { sid: "SM123", to: "+15551234567", status },
    nowMs: observedAt,
    store,
  });
  return await latestRecord(store);
}

async function recordCallback(
  store: PluginStateKeyedStore<SmsDeliveryRecord>,
  form: Record<string, string>,
  observedAt?: number,
) {
  const recorder = createSmsDeliveryRecorder(store);
  if (observedAt === undefined) {
    return await recorder.record({ account: createAccount(), form });
  }
  const now = vi.spyOn(Date, "now").mockReturnValue(observedAt);
  try {
    return await recorder.record({ account: createAccount(), form });
  } finally {
    now.mockRestore();
  }
}

describe("SMS delivery observations", () => {
  it("parses current and legacy status fields without retaining message content", async () => {
    const store = createStore();
    const current = await recordCallback(
      store,
      {
        AccountSid: "AC123",
        From: "+15557654321",
        To: "+15551234567",
        Body: "private message",
        MessageSid: "SM123",
        MessageStatus: "undelivered",
        ErrorCode: "30005",
        RawDlrDoneDate: "2608021200",
      },
      100,
    );
    const legacy = await recordCallback(
      store,
      {
        AccountSid: "AC123",
        From: "+15550000000",
        To: "+15559999999",
        Body: "different private message",
        SmsSid: "SM123",
        SmsStatus: "undelivered",
        ErrorCode: "30005",
        RawDlrDoneDate: "2608021200",
      },
      200,
    );

    expect(current).toMatchObject({
      duplicate: false,
      record: {
        messageSid: "SM123",
        status: "undelivered",
        observations: [
          {
            source: "callback",
            status: "undelivered",
            observedAt: 100,
            errorCode: "30005",
            rawDlrDoneDate: "2608021200",
          },
        ],
      },
    });
    expect(legacy).toMatchObject({
      duplicate: true,
      record: { observations: [{ observedAt: 100 }] },
    });
    expect(JSON.stringify(current.record)).not.toContain("+1555");
    expect(JSON.stringify(current.record)).not.toContain("private message");
    expect(JSON.stringify(current.record)).not.toContain("AC123");
  });

  it.each(["receiving", "received"])(
    "leaves legacy inbound SmsStatus=%s on the inbound path",
    async (status) => {
      const form = {
        MessageSid: "SM123",
        SmsStatus: status,
      };

      expect(isTwilioDeliveryStatusForm(form)).toBe(false);
      await expect(recordCallback(createStore(), form)).rejects.toThrow(
        "Invalid Twilio delivery status callback.",
      );
    },
  );

  it.each(["accepted", "scheduled"])(
    "advances a message from its %s initial state through sent",
    async (initialStatus) => {
      const store = createStore();
      for (const [index, status] of [initialStatus, "queued", "sending", "sent"].entries()) {
        const current = await recordApiStatus(store, status, index + 1);
        expect(current.status).toBe(status);
      }

      await recordCallback(store, { MessageSid: "SM123", MessageStatus: "queued" }, 10);
      expect((await latestRecord(store)).status).toBe("sent");
    },
  );

  it("allows a scheduled message to be canceled before queueing", async () => {
    const store = createStore();
    await recordApiStatus(store, "scheduled", 1);
    const canceled = await recordApiStatus(store, "canceled", 2);

    expect(canceled.status).toBe("canceled");
  });

  it("does not regress a terminal state when an older transition arrives late", async () => {
    const store = createStore();
    await recordApiStatus(store, "delivered", 200);
    const lateSent = await recordApiStatus(store, "sent", 300);

    expect(lateSent).toMatchObject({
      status: "delivered",
      firstObservedAt: 200,
      lastObservedAt: 300,
    });
    expect(lateSent.observations.map((entry) => entry.status)).toEqual(["delivered", "sent"]);
  });

  it("fills a missing error from a later observation of the same state", async () => {
    const store = createStore();
    await recordCallback(store, { MessageSid: "SM123", MessageStatus: "failed" }, 100);
    const enriched = await recordCallback(
      store,
      {
        MessageSid: "SM123",
        MessageStatus: "failed",
        ErrorCode: "30006",
      },
      200,
    );

    expect(enriched.record).toMatchObject({
      status: "failed",
      errorCode: "30006",
      lastObservedAt: 200,
    });
  });

  it("records conflicting terminal observations without choosing a false winner", async () => {
    const store = createStore();
    await recordCallback(store, { MessageSid: "SM123", MessageStatus: "delivered" }, 100);
    const failed = await recordCallback(
      store,
      {
        MessageSid: "SM123",
        MessageStatus: "failed",
        ErrorCode: "30006",
      },
      200,
    );

    expect(failed.record).toMatchObject({
      status: "conflicted",
      conflict: true,
      errorCode: "30006",
    });
  });

  it("deduplicates semantic retries despite unrelated form differences", async () => {
    const store = createStore();
    const recorder = createSmsDeliveryRecorder(store);
    const first = {
      AccountSid: "AC123",
      From: "+15557654321",
      To: "+15551234567",
      Body: "first",
      MessageSid: "SM123",
      MessageStatus: "delivered",
    };
    const retry = {
      ...first,
      From: "+15550000000",
      To: "+15559999999",
      Body: "changed",
    };

    await expect(recorder.record({ account: createAccount(), form: first })).resolves.toMatchObject(
      {
        duplicate: false,
        record: { status: "delivered" },
      },
    );
    await expect(recorder.record({ account: createAccount(), form: retry })).resolves.toMatchObject(
      {
        duplicate: true,
        record: { observations: [{ status: "delivered" }] },
      },
    );
  });

  it("isolates records by local account and account SID but survives token rotation", async () => {
    const store = createStore();
    const account = createAccount();
    const recorder = createSmsDeliveryRecorder(store);
    await recorder.record({
      account,
      form: {
        MessageSid: "SM123",
        MessageStatus: "delivered",
      },
    });

    await expect(listRecentSmsDeliveryRecords(createAccount("support"), 5, store)).resolves.toEqual(
      [],
    );
    await expect(
      listRecentSmsDeliveryRecords(createAccount("default", { accountSid: "AC-other" }), 5, store),
    ).resolves.toEqual([]);
    await expect(
      listRecentSmsDeliveryRecords(
        createAccount("default", { authToken: "rotated-secret" }),
        5,
        store,
      ),
    ).resolves.toMatchObject([
      {
        accountId: "default",
        messageSid: "SM123",
        status: "delivered",
      },
    ]);
  });

  it("records each successful API response and lets callbacks advance it", async () => {
    const store = createStore();
    const account = createAccount();
    for (const [index, status] of ["accepted", "scheduled", "queued"].entries()) {
      await recordInitialSmsDeliveryResult({
        account,
        result: {
          sid: `SM-${status}`,
          to: "+15551234567",
          status,
        },
        nowMs: index + 1,
        store,
      });
    }
    const recorder = createSmsDeliveryRecorder(store);
    await recorder.record({
      account,
      form: {
        MessageSid: "SM-queued",
        MessageStatus: "sent",
      },
    });

    await expect(listRecentSmsDeliveryRecords(account, 5, store)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageSid: "SM-accepted", status: "accepted" }),
        expect.objectContaining({ messageSid: "SM-scheduled", status: "scheduled" }),
        expect.objectContaining({
          messageSid: "SM-queued",
          status: "sent",
          observations: [
            expect.objectContaining({ source: "api-response", status: "queued" }),
            expect.objectContaining({ source: "callback", status: "sent" }),
          ],
        }),
      ]),
    );
  });

  it("skips API responses without an initial status", async () => {
    await expect(
      recordInitialSmsDeliveryResult({
        account: createAccount(),
        result: { sid: "SM123", to: "+15551234567" },
        store: createStore(),
      }),
    ).resolves.toBeNull();
  });

  it("bounds retained observations per message", async () => {
    const store = createStore();
    for (let index = 0; index < 25; index += 1) {
      await recordCallback(
        store,
        {
          MessageSid: "SM123",
          MessageStatus: "queued",
          RawDlrDoneDate: String(index),
        },
        index,
      );
    }

    const current = await latestRecord(store);
    expect(current.observations).toHaveLength(20);
    expect(current.observations[0]?.rawDlrDoneDate).toBe("5");
  });

  it("opens bounded plugin state and reopens it when the injected runtime changes", async () => {
    const firstStore = createStore();
    const secondStore = createStore();
    const firstOpen = vi.fn(() => firstStore);
    const secondOpen = vi.fn(() => secondStore);
    const account = createAccount();

    setSmsRuntime(
      createPluginRuntimeMock({
        state: { openKeyedStore: firstOpen as never },
      }),
    );
    await listRecentSmsDeliveryRecords(account);
    setSmsRuntime(
      createPluginRuntimeMock({
        state: { openKeyedStore: secondOpen as never },
      }),
    );
    await listRecentSmsDeliveryRecords(account);

    const expectedOptions = {
      namespace: "twilio-delivery-observations-v1",
      maxEntries: 5_000,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: 30 * 24 * 60 * 60 * 1000,
    };
    expect(firstOpen).toHaveBeenCalledExactlyOnceWith(expectedOptions);
    expect(secondOpen).toHaveBeenCalledExactlyOnceWith(expectedOptions);
  });
});
