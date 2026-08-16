// Line plugin module implements durable send plan persistence behavior.
import { createHash } from "node:crypto";
import type { messagingApi } from "@line/bot-sdk";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { z } from "zod";
import { getLineRuntime } from "./runtime.js";
import { LINE_RETRY_KEY_TTL_MS } from "./send-retry.js";

const PLAN_VERSION = 1;
const PLAN_NAMESPACE = "outbound-send-plans";
// A replay can only deduplicate while LINE still remembers the retry keys, so a
// plan is worthless past that point and must not outlive it.
const PLAN_TTL_MS = LINE_RETRY_KEY_TTL_MS;

/** One recorded platform send: the request LINE saw, under the key that deduplicates it. */
type LineDurablePush = {
  retryKey: string;
  messages: messagingApi.Message[];
};

/**
 * What one delivery part sent, and what it was sending. The payload is what lets
 * a replay finish a fan-out the crash cut in half; the pushes are what prove the
 * replay is reproducing that fan-out rather than a different one.
 */
type LineDurableSendPlan = {
  version: typeof PLAN_VERSION;
  queueId: string;
  partIndex: number;
  partCount: number;
  to: string;
  accountId?: string;
  payload: ReplyPayload;
  pushes: LineDurablePush[];
};

/** Refuses a reconciliation whose recorded evidence cannot be trusted to be complete. */
export class LineDurableSendPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineDurableSendPlanError";
  }
}

function createPlanStore() {
  return getLineRuntime().state.openBlobStore<Record<string, never>>({
    namespace: PLAN_NAMESPACE,
    maxEntries: 10_000,
    maxBytesPerEntry: 1024 * 1024,
    maxBytesPerNamespace: 64 * 1024 * 1024,
    // Evicting a plan would silently remove the only proof of what was already
    // sent, so a full namespace fails the send instead of the reconciliation.
    overflowPolicy: "reject-new",
    defaultTtlMs: PLAN_TTL_MS,
  });
}

function requireIndex(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LineDurableSendPlanError(
      `LINE durable send plan ${label} must be a non-negative integer`,
    );
  }
  return value;
}

function queuePrefix(queueId: string): string {
  const normalized = queueId.trim();
  if (!normalized) {
    throw new LineDurableSendPlanError("LINE durable send plan requires a queue id");
  }
  return `${createHash("sha256").update(normalized).digest("hex")}.`;
}

function planKey(queueId: string, partIndex: number): string {
  return `${queuePrefix(queueId)}${requireIndex(partIndex, "part index")}`;
}

// Stored bytes are a deserialization boundary, so the shape is parsed rather
// than asserted: a plan that no longer matches is refused, not trusted.
const lineMessageSchema = z.custom<messagingApi.Message>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string",
);

const replyPayloadSchema = z.custom<ReplyPayload>(
  (value) => typeof value === "object" && value !== null,
);

const planSchema = z
  .object({
    version: z.literal(PLAN_VERSION),
    queueId: z.string().trim().min(1),
    partIndex: z.number().int().nonnegative(),
    partCount: z.number().int().positive(),
    to: z.string().trim().min(1),
    accountId: z.string().optional(),
    payload: replyPayloadSchema,
    pushes: z
      .array(
        z.object({
          retryKey: z.string().trim().min(1),
          messages: z.array(lineMessageSchema).min(1),
        }),
      )
      .min(1),
  })
  .refine((plan) => plan.partIndex < plan.partCount, {
    message: "part index must be below the part count",
  });

function decodePlan(bytes: Uint8Array): LineDurableSendPlan {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LineDurableSendPlanError("LINE durable send plan is invalid JSON");
  }
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    throw new LineDurableSendPlanError("LINE durable send plan is invalid");
  }
  return parsed.data;
}

async function readPlan(queueId: string, partIndex: number): Promise<LineDurableSendPlan | null> {
  const entry = await createPlanStore().lookup(planKey(queueId, partIndex));
  return entry ? decodePlan(entry.bytes) : null;
}

async function writePlan(plan: LineDurableSendPlan): Promise<void> {
  const store = createPlanStore();
  await store.deleteExpired();
  await store.register(
    planKey(plan.queueId, plan.partIndex),
    new TextEncoder().encode(JSON.stringify(plan)),
    {},
  );
}

/** Records each push of one delivery part, before that push crosses the boundary. */
type LineDurablePushRecorder = {
  /** A property, not a method: the send options take it as a bare callback. */
  recordPush: (push: LineDurablePush) => Promise<void>;
  /** Refuses a fan-out that reproduced fewer pushes than the record it replayed. */
  assertRecordFullyReplayed: () => Promise<void>;
};

/**
 * Opens the recorded plan for one delivery part.
 *
 * A live send starts an empty record and appends to it. A replay re-enters the
 * same fan-out and finds that record already there, so every push it reproduces
 * is checked against what was actually sent before it is sent again — and the
 * pushes the interrupted fan-out never reached are simply appended and sent.
 * Live and replay run the same code, which is what keeps them from drifting.
 */
export function createLineDurablePushRecorder(params: {
  queueId: string;
  partIndex: number;
  partCount: number;
  to: string;
  accountId?: string;
  payload: ReplyPayload;
}): LineDurablePushRecorder {
  const plan: LineDurableSendPlan = {
    version: PLAN_VERSION,
    queueId: params.queueId,
    partIndex: requireIndex(params.partIndex, "part index"),
    partCount: requireIndex(params.partCount, "part count") || 1,
    to: params.to,
    ...(params.accountId === undefined ? {} : { accountId: params.accountId }),
    payload: params.payload,
    pushes: [],
  };
  let loaded = false;
  let produced = 0;
  // Seed from what is already on disk. A replay must never shrink the record it
  // is replaying: a second crash would then leave later pushes with nothing to
  // be compared against, and a diverged fan-out could go out under keys LINE has
  // already accepted.
  const loadRecordedPushes = async (): Promise<void> => {
    if (loaded) {
      return;
    }
    plan.pushes = (await readPlan(params.queueId, plan.partIndex))?.pushes ?? [];
    loaded = true;
  };
  return {
    // An arrow keeps the recorder usable as a bare callback on the send options.
    recordPush: async (push: LineDurablePush): Promise<void> => {
      await loadRecordedPushes();
      const previous = plan.pushes[produced];
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(push)) {
          // The fan-out no longer reproduces what LINE was asked to deliver, so
          // resending under these keys would drop content behind a stale 409.
          throw new LineDurableSendPlanError(
            `LINE durable send plan part ${plan.partIndex} no longer reproduces its recorded push ${produced}`,
          );
        }
        produced += 1;
        return;
      }
      plan.pushes.push(push);
      produced += 1;
      await writePlan(plan);
    },
    assertRecordFullyReplayed: async (): Promise<void> => {
      // The fan-out is rebuilt from live configuration, so a limit change can
      // make it render fewer pushes than were recorded. Settling that as sent
      // would drop a recorded push that may never have reached LINE.
      await loadRecordedPushes();
      if (produced < plan.pushes.length) {
        throw new LineDurableSendPlanError(
          `LINE durable send plan part ${plan.partIndex} reproduced ${produced} of its ${plan.pushes.length} recorded pushes`,
        );
      }
    },
  };
}

/**
 * Loads every recorded part of one delivery. A missing part is refused rather
 * than replayed: core planned it, nothing recorded it, and what it would have
 * said only ever existed inside the interrupted run.
 */
export async function loadLineDurableSendPlans(queueId: string): Promise<LineDurableSendPlan[]> {
  const store = createPlanStore();
  const prefix = queuePrefix(queueId);
  const keys = (await store.entries())
    .filter((entry) => entry.key.startsWith(prefix))
    .map((entry) => entry.key);
  if (keys.length === 0) {
    return [];
  }
  const plans = await Promise.all(
    keys.map(async (key) => {
      const entry = await store.lookup(key);
      if (!entry) {
        throw new LineDurableSendPlanError(
          "LINE durable send plan disappeared during reconciliation",
        );
      }
      const plan = decodePlan(entry.bytes);
      if (key !== planKey(plan.queueId, plan.partIndex) || plan.queueId !== queueId.trim()) {
        throw new LineDurableSendPlanError("LINE durable send plan key is invalid");
      }
      return plan;
    }),
  );
  assertCompletePartTopology(plans);
  return plans.toSorted((left, right) => left.partIndex - right.partIndex);
}

function assertCompletePartTopology(plans: readonly LineDurableSendPlan[]): void {
  const partCount = plans[0]?.partCount;
  if (!partCount) {
    throw new LineDurableSendPlanError("LINE ambiguous delivery has no recorded send plan");
  }
  if (plans.some((plan) => plan.partCount !== partCount)) {
    throw new LineDurableSendPlanError("LINE durable send plan part topology is inconsistent");
  }
  const recorded = new Set(plans.map((plan) => plan.partIndex));
  const missing = Array.from({ length: partCount }, (_, partIndex) => partIndex).filter(
    (partIndex) => !recorded.has(partIndex),
  );
  if (missing.length > 0) {
    throw new LineDurableSendPlanError(
      `LINE ambiguous delivery is missing recorded parts: ${missing.join(", ")}`,
    );
  }
}

/** Drops a settled delivery's recorded content once no replay can need it again. */
export async function clearLineDurableSendPlans(queueId: string): Promise<void> {
  const store = createPlanStore();
  await store.deleteExpired();
  const prefix = queuePrefix(queueId);
  const keys = (await store.entries())
    .filter((entry) => entry.key.startsWith(prefix))
    .map((entry) => entry.key);
  await Promise.all(keys.map(async (key) => await store.delete(key)));
}
