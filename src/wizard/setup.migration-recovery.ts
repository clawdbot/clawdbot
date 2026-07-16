// Onboarding migration recovery records live with the generated migration report.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readDurableJsonFile, writeJsonAtomic } from "../infra/json-files.js";
import { summarizeMigrationItems } from "../plugin-sdk/migration.js";
import type { MigrationApplyResult, MigrationItem, MigrationPlan } from "../plugins/types.js";
import { resolveUserPath } from "../utils.js";

const SETUP_MIGRATION_ATTEMPT_FILE = "onboarding-attempt.json";
const SETUP_MIGRATION_ATTEMPT_VERSION = 1;

type SetupMigrationAttemptStatus = "applying" | "failed" | "succeeded";

type SetupMigrationAttemptItem = {
  id: string;
  fingerprint: string;
  resultStatus?: MigrationItem["status"];
};

type SetupMigrationAttempt = {
  version: typeof SETUP_MIGRATION_ATTEMPT_VERSION;
  providerId: string;
  sourceHash: string;
  sourceSnapshotHash: string;
  workspaceHash: string;
  planFingerprint: string;
  items: SetupMigrationAttemptItem[];
  itemStatusesCaptured: boolean;
  targetSnapshotHashPrepared: string;
  targetSnapshotHashBefore: string;
  targetSnapshotHashAfter?: string;
  status: SetupMigrationAttemptStatus;
  startedAt: string;
  updatedAt: string;
};

type SetupMigrationRecoveryState =
  | { kind: "none" }
  | { kind: "recoverable"; attempt: SetupMigrationAttempt };

type SetupMigrationIdentity = {
  providerId: string;
  source: string;
  workspaceDir: string;
};

/** Hermes enumerates its replay inputs and has idempotent or conflict-checked item writes. */
export function setupMigrationProviderSupportsRecovery(providerId: string): boolean {
  return providerId === "hermes";
}

function buildPathHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildSourceHash(source: string): string {
  return buildPathHash(path.resolve(resolveUserPath(source.trim())));
}

function buildWorkspaceHash(workspaceDir: string): string {
  return buildPathHash(path.resolve(workspaceDir));
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalizeJsonValue(record[key])]),
  );
}

function buildMigrationItemFingerprint(item: MigrationItem): string {
  const { status: _status, reason: _reason, ...identity } = item;
  return buildPathHash(JSON.stringify(canonicalizeJsonValue(identity)));
}

function buildMigrationPlanFingerprint(plan: MigrationPlan): string {
  return buildPathHash(
    JSON.stringify(
      canonicalizeJsonValue({
        providerId: plan.providerId,
        source: plan.source,
        target: plan.target,
        metadata: plan.metadata,
      }),
    ),
  );
}

function isMigrationItemStatus(value: unknown): value is MigrationItem["status"] {
  return (
    value === "planned" ||
    value === "migrated" ||
    value === "skipped" ||
    value === "warning" ||
    value === "conflict" ||
    value === "error"
  );
}

function isSetupMigrationAttemptItem(value: unknown): value is SetupMigrationAttemptItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const item = value as Partial<SetupMigrationAttemptItem>;
  return (
    typeof item.id === "string" &&
    typeof item.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(item.fingerprint) &&
    (item.resultStatus === undefined || isMigrationItemStatus(item.resultStatus))
  );
}

function isSetupMigrationAttempt(value: unknown): value is SetupMigrationAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Partial<SetupMigrationAttempt>;
  return (
    record.version === SETUP_MIGRATION_ATTEMPT_VERSION &&
    typeof record.providerId === "string" &&
    typeof record.sourceHash === "string" &&
    /^[a-f0-9]{64}$/.test(record.sourceHash) &&
    typeof record.sourceSnapshotHash === "string" &&
    /^[a-f0-9]{64}$/.test(record.sourceSnapshotHash) &&
    typeof record.workspaceHash === "string" &&
    /^[a-f0-9]{64}$/.test(record.workspaceHash) &&
    typeof record.planFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(record.planFingerprint) &&
    Array.isArray(record.items) &&
    record.items.every(isSetupMigrationAttemptItem) &&
    typeof record.itemStatusesCaptured === "boolean" &&
    typeof record.targetSnapshotHashPrepared === "string" &&
    /^[a-f0-9]{64}$/.test(record.targetSnapshotHashPrepared) &&
    typeof record.targetSnapshotHashBefore === "string" &&
    /^[a-f0-9]{64}$/.test(record.targetSnapshotHashBefore) &&
    (record.targetSnapshotHashAfter === undefined ||
      (typeof record.targetSnapshotHashAfter === "string" &&
        /^[a-f0-9]{64}$/.test(record.targetSnapshotHashAfter))) &&
    (record.status === "applying" || record.status === "failed" || record.status === "succeeded") &&
    (record.status !== "failed" || record.targetSnapshotHashAfter !== undefined) &&
    typeof record.startedAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function createSetupMigrationAttempt(
  params: SetupMigrationIdentity & {
    plan: MigrationPlan;
    sourceSnapshotHash: string;
    preparedTargetSnapshotHash?: string;
    targetSnapshotHash: string;
    previousAttempt?: SetupMigrationAttempt;
  },
  now = new Date(),
): SetupMigrationAttempt {
  const timestamp = now.toISOString();
  const previousItems = params.previousAttempt?.items;
  return {
    version: SETUP_MIGRATION_ATTEMPT_VERSION,
    providerId: params.providerId,
    sourceHash: buildSourceHash(params.source),
    sourceSnapshotHash: params.sourceSnapshotHash,
    workspaceHash: buildWorkspaceHash(params.workspaceDir),
    planFingerprint: buildMigrationPlanFingerprint(params.plan),
    items: params.plan.items.map((item, index) => {
      const fingerprint = buildMigrationItemFingerprint(item);
      const previous = previousItems?.[index];
      return {
        id: item.id,
        fingerprint,
        ...(previous?.id === item.id && previous.fingerprint === fingerprint
          ? { resultStatus: previous.resultStatus }
          : {}),
      };
    }),
    itemStatusesCaptured: false,
    targetSnapshotHashPrepared: params.preparedTargetSnapshotHash ?? params.targetSnapshotHash,
    targetSnapshotHashBefore: params.targetSnapshotHash,
    status: "applying",
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

async function writeSetupMigrationAttempt(params: {
  reportDir: string;
  attempt: SetupMigrationAttempt;
  status: SetupMigrationAttemptStatus;
  result?: MigrationApplyResult;
  targetSnapshotHash?: string;
}): Promise<void> {
  const resultItems = params.result?.items;
  const itemStatusesCaptured =
    resultItems?.length === params.attempt.items.length &&
    resultItems.every((item, index) => item.id === params.attempt.items[index]?.id);
  const items = itemStatusesCaptured
    ? params.attempt.items.map((item, index) => ({
        ...item,
        resultStatus:
          item.resultStatus === "migrated" && resultItems?.[index]?.status === "skipped"
            ? "migrated"
            : resultItems?.[index]?.status,
      }))
    : params.attempt.items;
  await writeJsonAtomic(
    path.join(params.reportDir, SETUP_MIGRATION_ATTEMPT_FILE),
    {
      ...params.attempt,
      items,
      itemStatusesCaptured,
      ...(params.targetSnapshotHash ? { targetSnapshotHashAfter: params.targetSnapshotHash } : {}),
      status: params.status,
      updatedAt: new Date().toISOString(),
    },
    { mode: 0o600, dirMode: 0o700, trailingNewline: true },
  );
}

/** Runs provider apply while durably recording completion or a safe retry boundary. */
export async function runSetupMigrationAttempt(params: {
  reportDir: string;
  attempt: SetupMigrationAttempt;
  apply: () => Promise<MigrationApplyResult>;
  assertSucceeded: (result: MigrationApplyResult) => void;
  readTargetSnapshot: () => Promise<string>;
}): Promise<MigrationApplyResult> {
  await writeSetupMigrationAttempt({
    reportDir: params.reportDir,
    attempt: params.attempt,
    status: "applying",
  });
  let result: MigrationApplyResult | undefined;
  try {
    result = await params.apply();
    params.assertSucceeded(result);
  } catch (error) {
    try {
      await writeSetupMigrationAttempt({
        reportDir: params.reportDir,
        attempt: params.attempt,
        status: "failed",
        result,
        targetSnapshotHash: await params.readTargetSnapshot(),
      });
    } catch (recoveryError) {
      const failure = new AggregateError(
        [error, recoveryError],
        "Migration import failed and its retry record could not be updated.",
        { cause: recoveryError },
      );
      throw failure;
    }
    throw error;
  }
  await writeSetupMigrationAttempt({
    reportDir: params.reportDir,
    attempt: params.attempt,
    status: "succeeded",
    result,
  });
  return result;
}

async function findLatestSetupMigrationAttempt(params: {
  stateDir: string;
  providerId: string;
  matches: (attempt: SetupMigrationAttempt) => boolean;
}): Promise<SetupMigrationAttempt | undefined> {
  const providerReportRoot = path.join(params.stateDir, "migration", params.providerId);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(providerReportRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .toSorted((left, right) => (left.name < right.name ? 1 : left.name > right.name ? -1 : 0))) {
    const recordPath = path.join(providerReportRoot, entry.name, SETUP_MIGRATION_ATTEMPT_FILE);
    let value: unknown;
    try {
      value = await readDurableJsonFile<unknown>(recordPath);
    } catch (error) {
      throw new Error(`Invalid onboarding migration recovery record: ${recordPath}`, {
        cause: error,
      });
    }
    if (value === null) {
      continue;
    }
    if (!isSetupMigrationAttempt(value)) {
      throw new Error(`Invalid onboarding migration recovery record: ${recordPath}`);
    }
    if (value.providerId === params.providerId && params.matches(value)) {
      return value;
    }
  }
  return undefined;
}

/** Allows retry only while the target still matches the recorded attempt boundary. */
export async function resolveSetupMigrationRecovery(params: {
  stateDir: string;
  providerId: string;
  workspaceDir: string;
  targetSnapshotHash: string;
}): Promise<SetupMigrationRecoveryState> {
  const workspaceHash = buildWorkspaceHash(params.workspaceDir);
  const attempt = await findLatestSetupMigrationAttempt({
    stateDir: params.stateDir,
    providerId: params.providerId,
    matches: (candidate) => candidate.workspaceHash === workspaceHash,
  });
  if (!attempt || attempt.status === "succeeded") {
    return { kind: "none" };
  }
  if (attempt.status === "applying") {
    return attempt.targetSnapshotHashPrepared === params.targetSnapshotHash ||
      attempt.targetSnapshotHashBefore === params.targetSnapshotHash
      ? { kind: "recoverable", attempt }
      : { kind: "none" };
  }
  if (attempt.targetSnapshotHashAfter !== params.targetSnapshotHash) {
    return { kind: "none" };
  }
  return attempt.itemStatusesCaptured ||
    attempt.targetSnapshotHashPrepared === params.targetSnapshotHash ||
    attempt.targetSnapshotHashBefore === params.targetSnapshotHash
    ? { kind: "recoverable", attempt }
    : { kind: "none" };
}

export function setupMigrationAttemptMatchesSource(
  attempt: SetupMigrationAttempt,
  source: string,
): boolean {
  return attempt.sourceHash === buildSourceHash(source);
}

/** Reuses an unchanged plan while suppressing items already completed by the failed run. */
export function prepareSetupMigrationRetryPlan(
  plan: MigrationPlan,
  attempt: SetupMigrationAttempt,
  sourceSnapshotHash: string,
): MigrationPlan {
  if (attempt.sourceSnapshotHash !== sourceSnapshotHash) {
    throw new Error(
      "Migration source changed since the failed attempt. Review it before starting a new import.",
    );
  }
  if (attempt.planFingerprint !== buildMigrationPlanFingerprint(plan)) {
    throw new Error(
      "Migration retry plan context changed since the failed attempt. Review it before retrying.",
    );
  }
  if (
    plan.items.length !== attempt.items.length ||
    plan.items.some((item, index) => {
      const previous = attempt.items[index];
      return (
        !previous ||
        previous.id !== item.id ||
        previous.fingerprint !== buildMigrationItemFingerprint(item)
      );
    })
  ) {
    throw new Error(
      "Migration retry plan changed since the failed attempt. Review the source and target before retrying.",
    );
  }
  const items = plan.items.map((item, index) => {
    const resultStatus = attempt.items[index]?.resultStatus;
    if (resultStatus !== "migrated" || item.action === "archive") {
      return item;
    }
    return {
      ...item,
      status: "skipped" as const,
      reason: "already completed by the previous onboarding import attempt",
    };
  });
  return { ...plan, items, summary: summarizeMigrationItems(items) };
}
