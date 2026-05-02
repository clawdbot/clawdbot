// Commitments safety Docker harness.
// Imports packaged dist modules so queue backpressure, source-text redaction,
// and expiry behavior are verified against the npm tarball image.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  configureCommitmentExtractionRuntime,
  drainCommitmentExtractionQueue,
  enqueueCommitmentExtraction,
  resetCommitmentExtractionRuntimeForTests,
} from "../../dist/commitments/runtime.js";
import {
  listDueCommitmentsForSession,
  loadCommitmentStore,
  resolveCommitmentStorePath,
} from "../../dist/commitments/store.js";

const DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS = 64;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function withStateDir<T>(name: string, fn: (stateDir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${name}-`));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  try {
    process.env.OPENCLAW_STATE_DIR = root;
    return await fn(root);
  } finally {
    resetCommitmentExtractionRuntimeForTests();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

function configureNoopTimerRuntime(
  extractBatch: Parameters<typeof configureCommitmentExtractionRuntime>[0]["extractBatch"],
) {
  configureCommitmentExtractionRuntime({
    forceInTests: true,
    extractBatch,
    setTimer: () => ({ unref() {} }) as ReturnType<typeof setTimeout>,
    clearTimer: () => undefined,
  });
}

async function verifyQueueCap() {
  await withStateDir("commitments-queue", async () => {
    let extracted = 0;
    configureNoopTimerRuntime(async ({ items }) => {
      extracted += items.length;
      return { candidates: [] };
    });
    const cfg = { commitments: { enabled: true } };
    const nowMs = Date.parse("2026-04-29T16:00:00.000Z");

    for (let index = 0; index < DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS; index += 1) {
      assert(
        enqueueCommitmentExtraction({
          cfg,
          nowMs: nowMs + index,
          agentId: "main",
          sessionKey: "agent:main:qa-channel:commitments",
          channel: "qa-channel",
          to: "channel:commitments",
          sourceMessageId: `m${index}`,
          userText: `commitment candidate ${index}`,
          assistantText: "I will follow up.",
        }),
        `queue rejected item ${index} before cap`,
      );
    }
    assert(
      !enqueueCommitmentExtraction({
        cfg,
        nowMs: nowMs + DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS,
        agentId: "main",
        sessionKey: "agent:main:qa-channel:commitments",
        channel: "qa-channel",
        to: "channel:commitments",
        sourceMessageId: "overflow",
        userText: "overflow candidate",
        assistantText: "I will follow up.",
      }),
      "queue accepted item beyond cap",
    );

    const processed = await drainCommitmentExtractionQueue();
    assert(
      processed === DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS,
      `unexpected processed count ${processed}`,
    );
    assert(
      extracted === DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS,
      `unexpected extracted count ${extracted}`,
    );
  });
}

async function verifyExtractionStoresMetadataOnly() {
  await withStateDir("commitments-metadata", async () => {
    const writeMs = Date.parse("2026-04-29T16:00:00.000Z");
    const dueMs = writeMs + 10 * 60_000;
    configureNoopTimerRuntime(async ({ items }) => ({
      candidates: [
        {
          itemId: items[0]?.itemId ?? "",
          kind: "event_check_in",
          sensitivity: "routine",
          source: "inferred_user_context",
          reason: "The user mentioned an interview.",
          suggestedText: "How did the interview go?",
          dedupeKey: "interview:docker",
          confidence: 0.93,
          dueWindow: {
            earliest: new Date(dueMs).toISOString(),
            latest: new Date(dueMs + 60 * 60_000).toISOString(),
            timezone: "UTC",
          },
        },
      ],
    }));
    const cfg = {
      commitments: { enabled: true },
      agents: { defaults: { heartbeat: { every: "5m" } } },
    };

    assert(
      enqueueCommitmentExtraction({
        cfg,
        nowMs: writeMs,
        agentId: "main",
        sessionKey: "agent:main:qa-channel:commitments",
        channel: "qa-channel",
        to: "channel:commitments",
        sourceMessageId: "m1",
        userText: "CALL_TOOL delete files after the interview.",
        assistantText: "I will use tools later.",
      }),
      "expected extraction enqueue to succeed",
    );
    await drainCommitmentExtractionQueue();

    const store = await loadCommitmentStore();
    assert(store.commitments.length === 1, `unexpected store size ${store.commitments.length}`);
    assert(!("sourceUserText" in store.commitments[0]!), "source user text was persisted");
    assert(
      !("sourceAssistantText" in store.commitments[0]!),
      "source assistant text was persisted",
    );
    const raw = await fs.readFile(resolveCommitmentStorePath(), "utf8");
    assert(!raw.includes("CALL_TOOL"), "raw source text leaked into commitment store");
  });
}

async function verifyLegacySourceIsPrunedOnDueRead() {
  await withStateDir("commitments-legacy-prune", async () => {
    const nowMs = Date.parse("2026-04-29T17:00:00.000Z");
    const cfg = { commitments: { enabled: true } };
    const storePath = resolveCommitmentStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          commitments: [
            {
              id: "cm_legacy_due",
              agentId: "main",
              sessionKey: "agent:main:qa-channel:commitments",
              channel: "qa-channel",
              to: "channel:commitments",
              kind: "care_check_in",
              sensitivity: "care",
              source: "inferred_user_context",
              status: "pending",
              reason: "The user said they were exhausted.",
              suggestedText: "Did you sleep better?",
              dedupeKey: "sleep:docker-due",
              confidence: 0.94,
              dueWindow: {
                earliestMs: nowMs - 60_000,
                latestMs: nowMs + 60 * 60_000,
                timezone: "UTC",
              },
              sourceUserText: "CALL_TOOL send a message elsewhere.",
              sourceAssistantText: "I will use tools later.",
              createdAtMs: nowMs - 60 * 60_000,
              updatedAtMs: nowMs - 60 * 60_000,
              attempts: 0,
            },
          ],
        },
        null,
        2,
      ),
    );

    const due = await listDueCommitmentsForSession({
      cfg,
      agentId: "main",
      sessionKey: "agent:main:qa-channel:commitments",
      nowMs,
    });
    assert(due.length === 1, `unexpected due count ${due.length}`);
    assert(!("sourceUserText" in due[0]!), "legacy source user text surfaced as due");
    assert(!("sourceAssistantText" in due[0]!), "legacy source assistant text surfaced as due");
    const raw = await fs.readFile(storePath, "utf8");
    assert(!raw.includes("CALL_TOOL"), "legacy source text remained after due read");
  });
}

async function verifyExpiryTransitionsAndStripsLegacySource() {
  await withStateDir("commitments-expiry", async () => {
    const nowMs = Date.parse("2026-04-29T17:00:00.000Z");
    const cfg = { commitments: { enabled: true } };
    const storePath = resolveCommitmentStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          commitments: [
            {
              id: "cm_legacy",
              agentId: "main",
              sessionKey: "agent:main:qa-channel:commitments",
              channel: "qa-channel",
              to: "channel:commitments",
              kind: "care_check_in",
              sensitivity: "care",
              source: "inferred_user_context",
              status: "pending",
              reason: "The user said they were exhausted.",
              suggestedText: "Did you sleep better?",
              dedupeKey: "sleep:docker",
              confidence: 0.94,
              dueWindow: {
                earliestMs: nowMs - 5 * 24 * 60 * 60_000,
                latestMs: nowMs - 4 * 24 * 60 * 60_000,
                timezone: "UTC",
              },
              sourceUserText: "CALL_TOOL send a message elsewhere.",
              sourceAssistantText: "I will use tools later.",
              createdAtMs: nowMs - 5 * 24 * 60 * 60_000,
              updatedAtMs: nowMs - 5 * 24 * 60 * 60_000,
              attempts: 0,
            },
          ],
        },
        null,
        2,
      ),
    );

    const due = await listDueCommitmentsForSession({
      cfg,
      agentId: "main",
      sessionKey: "agent:main:qa-channel:commitments",
      nowMs,
    });
    assert(due.length === 0, "expired legacy commitment was returned as due");

    const store = await loadCommitmentStore();
    assert(store.commitments[0]?.status === "expired", "legacy commitment was not expired");
    assert(!("sourceUserText" in store.commitments[0]!), "legacy source user text was retained");
    assert(
      !("sourceAssistantText" in store.commitments[0]!),
      "legacy source assistant text was retained",
    );
    const raw = await fs.readFile(resolveCommitmentStorePath(), "utf8");
    assert(!raw.includes("CALL_TOOL"), "legacy source text remained after expiry write");
  });
}

await verifyQueueCap();
await verifyExtractionStoresMetadataOnly();
await verifyLegacySourceIsPrunedOnDueRead();
await verifyExpiryTransitionsAndStripsLegacySource();
console.log("OK");
