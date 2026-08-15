import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getSmsRuntime } from "./runtime.js";
import type { ResolvedSmsAccount, SmsSendResult } from "./types.js";

const DELIVERY_NAMESPACE = "twilio-delivery-observations-v1";
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DELIVERY_MAX_MESSAGES = 5_000;
const DELIVERY_MAX_OBSERVATIONS_PER_MESSAGE = 20;

const DELIVERY_STATUS_RANK: Readonly<Record<string, number>> = {
  accepted: 10,
  scheduled: 20,
  queued: 30,
  sending: 40,
  sent: 50,
};

const TERMINAL_DELIVERY_STATUSES = new Set(["delivered", "undelivered", "failed", "canceled"]);
const INBOUND_MESSAGE_STATUSES = new Set(["receiving", "received"]);

type SmsDeliveryObservationSource = "api-response" | "callback";

type SmsDeliveryObservation = {
  source: SmsDeliveryObservationSource;
  fingerprint: string;
  status: string;
  observedAt: number;
  errorCode?: string;
  rawDlrDoneDate?: string;
};

export type SmsDeliveryRecord = {
  accountId: string;
  accountSidHash: string;
  messageSid: string;
  status: string;
  firstObservedAt: number;
  lastObservedAt: number;
  errorCode?: string;
  conflict?: boolean;
  observations: SmsDeliveryObservation[];
};

export type SmsDeliveryRecorder = {
  record: (params: {
    account: ResolvedSmsAccount;
    form: Record<string, string>;
  }) => Promise<{ duplicate: boolean; record: SmsDeliveryRecord }>;
};

let deliveryStore: PluginStateKeyedStore<SmsDeliveryRecord> | undefined;
let deliveryStoreRuntime: ReturnType<typeof getSmsRuntime> | undefined;

function firstTrimmed(form: Record<string, string>, key: string): string {
  return form[key]?.trim() ?? "";
}

function resolveMessageSid(form: Record<string, string>): string {
  return (
    firstTrimmed(form, "MessageSid") ||
    firstTrimmed(form, "SmsSid") ||
    firstTrimmed(form, "SmsMessageSid")
  );
}

function normalizeDeliveryStatus(rawStatus: string): string {
  const status = rawStatus.trim().toLowerCase();
  return INBOUND_MESSAGE_STATUSES.has(status) ? "" : status;
}

function resolveDeliveryStatus(form: Record<string, string>): string {
  return normalizeDeliveryStatus(
    firstTrimmed(form, "MessageStatus") || firstTrimmed(form, "SmsStatus"),
  );
}

function hashAccountSid(accountSid: string): string {
  return createHash("sha256").update(accountSid).digest("hex");
}

function fingerprintObservation(params: {
  source: SmsDeliveryObservationSource;
  messageSid: string;
  status: string;
  errorCode?: string;
  rawDlrDoneDate?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        params.source,
        params.messageSid,
        params.status,
        params.errorCode ?? "",
        params.rawDlrDoneDate ?? "",
      ]),
    )
    .digest("hex");
}

function deliveryRecordKey(params: {
  accountId: string;
  accountSidHash: string;
  messageSid: string;
}): string {
  return createHash("sha256")
    .update(`${params.accountId}\n${params.accountSidHash}\n${params.messageSid}`)
    .digest("hex");
}

function openDeliveryStore(): PluginStateKeyedStore<SmsDeliveryRecord> {
  const runtime = getSmsRuntime();
  // This is bounded recent operator state, not an audit ledger. At capacity,
  // preserve callback availability and evict the least recently updated message.
  if (!deliveryStore || deliveryStoreRuntime !== runtime) {
    deliveryStoreRuntime = runtime;
    deliveryStore = runtime.state.openKeyedStore<SmsDeliveryRecord>({
      namespace: DELIVERY_NAMESPACE,
      maxEntries: DELIVERY_MAX_MESSAGES,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: DELIVERY_RETENTION_MS,
    });
  }
  return deliveryStore;
}

export function isTwilioDeliveryStatusForm(form: Record<string, string>): boolean {
  return Boolean(resolveDeliveryStatus(form));
}

function parseSmsDeliveryObservation(
  form: Record<string, string>,
  nowMs = Date.now(),
): { messageSid: string; observation: SmsDeliveryObservation } | null {
  const messageSid = resolveMessageSid(form);
  const status = resolveDeliveryStatus(form);
  if (!messageSid || !status) {
    return null;
  }
  const errorCode = firstTrimmed(form, "ErrorCode");
  const rawDlrDoneDate = firstTrimmed(form, "RawDlrDoneDate");
  return {
    messageSid,
    observation: {
      source: "callback",
      fingerprint: fingerprintObservation({
        source: "callback",
        messageSid,
        status,
        ...(errorCode ? { errorCode } : {}),
        ...(rawDlrDoneDate ? { rawDlrDoneDate } : {}),
      }),
      status,
      observedAt: nowMs,
      ...(errorCode ? { errorCode } : {}),
      ...(rawDlrDoneDate ? { rawDlrDoneDate } : {}),
    },
  };
}

function reduceDeliveryStatus(
  current: SmsDeliveryRecord | undefined,
  observation: SmsDeliveryObservation,
): Pick<SmsDeliveryRecord, "status" | "errorCode" | "conflict"> {
  if (!current) {
    return {
      status: observation.status,
      ...(observation.errorCode ? { errorCode: observation.errorCode } : {}),
    };
  }
  if (current.status === "conflicted") {
    return {
      status: current.status,
      ...(current.errorCode ? { errorCode: current.errorCode } : {}),
      conflict: true,
    };
  }

  if (current.status === observation.status) {
    const errorCode = current.errorCode ?? observation.errorCode;
    return {
      status: current.status,
      ...(errorCode ? { errorCode } : {}),
      ...(current.conflict ? { conflict: true } : {}),
    };
  }

  const currentTerminal = TERMINAL_DELIVERY_STATUSES.has(current.status);
  const nextTerminal = TERMINAL_DELIVERY_STATUSES.has(observation.status);
  if (currentTerminal && nextTerminal && current.status !== observation.status) {
    const errorCode = observation.errorCode ?? current.errorCode;
    return {
      status: "conflicted",
      ...(errorCode ? { errorCode } : {}),
      conflict: true,
    };
  }
  if (currentTerminal) {
    return {
      status: current.status,
      ...(current.errorCode ? { errorCode: current.errorCode } : {}),
      ...(current.conflict ? { conflict: true } : {}),
    };
  }
  if (nextTerminal) {
    return {
      status: observation.status,
      ...(observation.errorCode ? { errorCode: observation.errorCode } : {}),
    };
  }

  const currentRank = DELIVERY_STATUS_RANK[current.status] ?? -1;
  const nextRank = DELIVERY_STATUS_RANK[observation.status] ?? -1;
  if (nextRank > currentRank) {
    return {
      status: observation.status,
      ...(observation.errorCode ? { errorCode: observation.errorCode } : {}),
    };
  }
  return {
    status: current.status,
    ...(current.errorCode ? { errorCode: current.errorCode } : {}),
    ...(current.conflict ? { conflict: true } : {}),
  };
}

function mergeSmsDeliveryObservation(params: {
  accountId: string;
  accountSidHash: string;
  messageSid: string;
  current: SmsDeliveryRecord | undefined;
  observation: SmsDeliveryObservation;
}): SmsDeliveryRecord | undefined {
  if (
    params.current?.observations.some(
      (existing) => existing.fingerprint === params.observation.fingerprint,
    )
  ) {
    return undefined;
  }
  const reduced = reduceDeliveryStatus(params.current, params.observation);
  return {
    accountId: params.accountId,
    accountSidHash: params.accountSidHash,
    messageSid: params.messageSid,
    status: reduced.status,
    firstObservedAt: params.current?.firstObservedAt ?? params.observation.observedAt,
    lastObservedAt: params.observation.observedAt,
    ...(reduced.errorCode ? { errorCode: reduced.errorCode } : {}),
    ...(reduced.conflict ? { conflict: true } : {}),
    observations: [...(params.current?.observations ?? []), params.observation].slice(
      -DELIVERY_MAX_OBSERVATIONS_PER_MESSAGE,
    ),
  };
}

async function recordSmsDeliveryObservation(params: {
  account: ResolvedSmsAccount;
  messageSid: string;
  observation: SmsDeliveryObservation;
  store: PluginStateKeyedStore<SmsDeliveryRecord>;
}): Promise<{ duplicate: boolean; record: SmsDeliveryRecord }> {
  if (!params.store.update) {
    throw new Error("SMS delivery observations require atomic plugin state updates.");
  }
  const accountSidHash = hashAccountSid(params.account.accountSid);
  const key = deliveryRecordKey({
    accountId: params.account.accountId,
    accountSidHash,
    messageSid: params.messageSid,
  });
  let record: SmsDeliveryRecord | undefined;
  let duplicate = false;
  await params.store.update(key, (current) => {
    const next = mergeSmsDeliveryObservation({
      accountId: params.account.accountId,
      accountSidHash,
      messageSid: params.messageSid,
      current,
      observation: params.observation,
    });
    if (!next) {
      duplicate = true;
      record = current;
      return undefined;
    }
    record = next;
    return next;
  });
  if (!record) {
    throw new Error("SMS delivery observation was not persisted.");
  }
  return { duplicate, record };
}

export function createSmsDeliveryRecorder(
  store: PluginStateKeyedStore<SmsDeliveryRecord> = openDeliveryStore(),
): SmsDeliveryRecorder {
  return {
    async record({ account, form }) {
      const parsed = parseSmsDeliveryObservation(form);
      if (!parsed) {
        throw new Error("Invalid Twilio delivery status callback.");
      }
      return await recordSmsDeliveryObservation({
        account,
        messageSid: parsed.messageSid,
        observation: parsed.observation,
        store,
      });
    },
  };
}

export async function recordInitialSmsDeliveryResult(params: {
  account: ResolvedSmsAccount;
  result: SmsSendResult;
  nowMs?: number;
  store?: PluginStateKeyedStore<SmsDeliveryRecord>;
}): Promise<{ duplicate: boolean; record: SmsDeliveryRecord } | null> {
  const messageSid = params.result.sid.trim();
  const status = normalizeDeliveryStatus(params.result.status ?? "");
  if (!messageSid || !status) {
    return null;
  }
  return await recordSmsDeliveryObservation({
    account: params.account,
    messageSid,
    observation: {
      source: "api-response",
      fingerprint: fingerprintObservation({
        source: "api-response",
        messageSid,
        status,
      }),
      status,
      observedAt: params.nowMs ?? Date.now(),
    },
    store: params.store ?? openDeliveryStore(),
  });
}

export async function listRecentSmsDeliveryRecords(
  account: ResolvedSmsAccount,
  limit = 1,
  store: PluginStateKeyedStore<SmsDeliveryRecord> = openDeliveryStore(),
): Promise<SmsDeliveryRecord[]> {
  if (limit <= 0) {
    return [];
  }
  const accountSidHash = hashAccountSid(account.accountSid);
  return (await store.entries())
    .map((entry) => entry.value)
    .filter(
      (record) =>
        record.accountId === account.accountId && record.accountSidHash === accountSidHash,
    )
    .toSorted((left, right) => right.lastObservedAt - left.lastObservedAt)
    .slice(0, limit);
}
