// Commitments safety Docker harness against packaged dist modules.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enqueueCommitmentExtraction } from "../../dist/commitments/runtime.js";
import {
  configureCommitmentExtractionRuntime,
  drainCommitmentExtractionQueue,
  resetCommitmentExtractionRuntimeForTests,
} from "../../dist/commitments/runtime.test-support.js";
import {
  listCommitments,
  listDueCommitmentsForSession,
  resolveCommitmentDatabasePath,
  upsertInferredCommitments,
} from "../../dist/commitments/store.js";

const DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS = 64;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function setEnvValue(key: string, value: string): void {
  Reflect.set(process.env, key, value);
}

function deleteEnvValue(key: string): void {
  Reflect.deleteProperty(process.env, key);
}

async function withStateDir<T>(name: string, fn: (stateDir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${name}-`));
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  try {
    setEnvValue("OPENCLAW_STATE_DIR", root);
    return await fn(root);
  } finally {
    resetCommitmentExtractionRuntimeForTests();
    if (previousStateDir === undefined) {
      deleteEnvValue("OPENCLAW_STATE_DIR");
    } else {
      setEnvValue("OPENCLAW_STATE_DIR", previousStateDir);
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
    assert(processed === 64, `unexpected processed count ${processed}`);
    assert(extracted === 64, `unexpected extracted count ${extracted}`);
  });
}

async function verifyExtractionStoresTypedMetadataOnly() {
  await withStateDir("commitments-metadata", async (stateDir) => {
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

    const commitments = await listCommitments({ nowMs: writeMs });
    assert(commitments.length === 1, `unexpected commitment count ${commitments.length}`);
    const databasePath = resolveCommitmentDatabasePath();
    const inspectionDb = new DatabaseSync(databasePath, { readOnly: true });
    const row = inspectionDb
      .prepare("SELECT status, reason, record_json FROM commitments LIMIT 1")
      .get() as { status?: unknown; reason?: unknown; record_json?: unknown } | undefined;
    inspectionDb.close();
    assert(row?.status === "pending", "typed status column missing");
    assert(row?.reason === "The user mentioned an interview.", "typed reason column missing");
    assert(typeof row.record_json === "string", "record_json missing");
    assert(!row.record_json.includes("CALL_TOOL"), "raw source text leaked into record_json");
    await fs.access(databasePath);
    await fs
      .access(path.join(stateDir, "commitments", "commitments.json"))
      .then(() => {
        throw new Error("runtime created retired commitments JSON");
      })
      .catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== "ENOENT") {
          throw error;
        }
      });
  });
}

function legacyRecord(nowMs: number, stale = false) {
  return {
    id: stale ? "cm_legacy_stale" : "cm_legacy_due",
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
    dedupeKey: stale ? "sleep:docker-stale" : "sleep:docker-due",
    confidence: 0.94,
    dueWindow: stale
      ? {
          earliestMs: nowMs - 5 * 24 * 60 * 60_000,
          latestMs: nowMs - 4 * 24 * 60 * 60_000,
          timezone: "UTC",
        }
      : {
          earliestMs: nowMs - 60_000,
          latestMs: nowMs + 60 * 60_000,
          timezone: "UTC",
        },
    sourceUserText: "CALL_TOOL send a message elsewhere.",
    sourceAssistantText: "I will use tools later.",
    createdAtMs: nowMs - 5 * 24 * 60 * 60_000,
    updatedAtMs: nowMs - 5 * 24 * 60 * 60_000,
    attempts: 0,
  };
}

async function runPackagedDoctor(stateDir: string): Promise<void> {
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(configPath, JSON.stringify({ plugins: { enabled: false } }, null, 2));
  const entry = await fs.stat("dist/index.mjs").then(
    () => "dist/index.mjs",
    () => "dist/index.js",
  );
  const result = spawnSync(process.execPath, [entry, "doctor", "--fix", "--yes", "--force"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BONJOUR: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_NO_ONBOARD: "1",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert(
    result.status === 0,
    `doctor --fix failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

async function verifyDoctorImportAndRuntimeIsolation() {
  await withStateDir("commitments-doctor", async (stateDir) => {
    const nowMs = Date.parse("2026-04-29T17:00:00.000Z");
    const cfg = { commitments: { enabled: true } };
    const sourcePath = path.join(stateDir, "commitments", "commitments.json");
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(
      sourcePath,
      JSON.stringify({ version: 1, commitments: [legacyRecord(nowMs)] }, null, 2),
      "utf8",
    );

    const beforeDoctor = await listDueCommitmentsForSession({
      cfg,
      agentId: "main",
      sessionKey: "agent:main:qa-channel:commitments",
      nowMs,
    });
    assert(beforeDoctor.length === 0, "runtime imported legacy JSON without doctor");
    await fs.access(sourcePath);

    await runPackagedDoctor(stateDir);
    await fs
      .access(sourcePath)
      .then(() => {
        throw new Error("doctor retained verified legacy JSON");
      })
      .catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== "ENOENT") {
          throw error;
        }
      });

    const due = await listDueCommitmentsForSession({
      cfg,
      agentId: "main",
      sessionKey: "agent:main:qa-channel:commitments",
      nowMs,
    });
    assert(due.length === 1, `unexpected imported due count ${due.length}`);
    assert(!("sourceUserText" in due[0]), "legacy source user text surfaced after import");
    assert(
      !("sourceAssistantText" in due[0]),
      "legacy source assistant text surfaced after import",
    );
  });
}

async function verifyExpiryTransition() {
  await withStateDir("commitments-expiry", async () => {
    const nowMs = Date.parse("2026-04-29T17:00:00.000Z");
    await upsertInferredCommitments({
      item: {
        itemId: "stale",
        agentId: "main",
        sessionKey: "agent:main:qa-channel:commitments",
        channel: "qa-channel",
        to: "channel:commitments",
        nowMs,
        timezone: "UTC",
        userText: "stale",
        existingPending: [],
      },
      candidates: [
        {
          candidate: {
            itemId: "stale",
            kind: "care_check_in",
            sensitivity: "care",
            source: "inferred_user_context",
            reason: "The user was exhausted.",
            suggestedText: "Did you sleep better?",
            dedupeKey: "sleep:docker-expiry",
            confidence: 0.94,
            dueWindow: { earliest: new Date(nowMs).toISOString() },
          },
          earliestMs: nowMs - 5 * 24 * 60 * 60_000,
          latestMs: nowMs - 4 * 24 * 60 * 60_000,
          timezone: "UTC",
        },
      ],
      nowMs: nowMs - 5 * 24 * 60 * 60_000,
    });
    const due = await listDueCommitmentsForSession({
      cfg: { commitments: { enabled: true } },
      agentId: "main",
      sessionKey: "agent:main:qa-channel:commitments",
      nowMs,
    });
    assert(due.length === 0, "expired commitment was returned as due");
    const commitments = await listCommitments({ nowMs });
    assert(commitments[0]?.status === "expired", "stale commitment was not expired");
  });
}

await verifyQueueCap();
await verifyExtractionStoresTypedMetadataOnly();
await verifyDoctorImportAndRuntimeIsolation();
await verifyExpiryTransition();
console.log("OK");
