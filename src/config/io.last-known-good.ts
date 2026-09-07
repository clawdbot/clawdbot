// Retains and restores the last-known-good config snapshot promoted by Gateway
// startup. The retained `.last-good` copy is the recovery source of record for
// hand-authored accepted baselines, whose `.bak` predates the operator's file.
import { isRecord } from "../utils.js";
import { appendConfigAuditRecord } from "./io.audit.js";
import { persistBoundedClobberedConfigSnapshot } from "./io.clobber-snapshot.js";
import {
  readConfigHealthStateFromStore,
  writeConfigHealthStateToStore,
} from "./io.health-state.js";
import {
  chmodConfigBestEffort,
  createConfigObserveAuditAppendParams,
  createRecoveryCommitEffect,
  resolveLastKnownGoodConfigPath,
  type ObserveRecoveryDeps,
} from "./io.observe-recovery.js";
import {
  createConfigHealthFingerprint,
  readConfigHealthEntry,
  updateConfigHealthEntry,
} from "./io.observe-state.js";
import { hashConfigRaw, resolveConfigSnapshotHash } from "./io.read-helpers.js";
import type { PrepareConfigRecoveryCandidate } from "./io.types.js";
import { formatConfigIssueSummary } from "./issue-format.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import {
  isPluginLocalInvalidConfigSnapshot,
  shouldAttemptLastKnownGoodRecovery,
} from "./recovery-policy.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

function isSensitiveConfigPath(pathLabel: string): boolean {
  return /(^|\.)(api[-_]?key|auth|bearer|credential|password|private[-_]?key|secret|token)(\.|$)/i.test(
    pathLabel,
  );
}

function collectPollutedSecretPlaceholders(
  value: unknown,
  pathLabel = "",
  output: string[] = [],
): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "***" || trimmed === "[redacted]") {
      output.push(pathLabel || "<root>");
      return output;
    }
    if (isSensitiveConfigPath(pathLabel) && (trimmed.includes("...") || trimmed.includes("…"))) {
      output.push(pathLabel || "<root>");
    }
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectPollutedSecretPlaceholders(item, `${pathLabel}[${index}]`, output),
    );
    return output;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = pathLabel ? `${pathLabel}.${key}` : key;
      collectPollutedSecretPlaceholders(child, childPath, output);
    }
  }
  return output;
}

export async function promoteConfigSnapshotToLastKnownGoodCore(params: {
  deps: ObserveRecoveryDeps;
  snapshot: ConfigFileSnapshot;
  logger?: Pick<typeof console, "warn">;
}): Promise<boolean> {
  const { deps, snapshot } = params;
  if (!snapshot.exists || !snapshot.valid || typeof snapshot.raw !== "string") {
    return false;
  }
  const polluted = collectPollutedSecretPlaceholders(snapshot.parsed);
  if (polluted.length > 0) {
    params.logger?.warn(
      `Config last-known-good promotion skipped: redacted secret placeholder at ${polluted[0]}`,
    );
    return false;
  }
  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    hash: resolveConfigSnapshotHash(snapshot) ?? undefined,
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    resolved: snapshot.resolved,
    stat,
    observedAt: now,
  });
  const lastGoodPath = resolveLastKnownGoodConfigPath(snapshot.path);
  await deps.fs.promises.writeFile(lastGoodPath, snapshot.raw, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await chmodConfigBestEffort({
    deps,
    configPath: lastGoodPath,
    context: "last-known-good promotion",
  });
  const healthState = readConfigHealthStateFromStore(deps);
  const entry = readConfigHealthEntry(healthState, snapshot.path);
  writeConfigHealthStateToStore(
    deps,
    updateConfigHealthEntry(healthState, snapshot.path, {
      ...entry,
      lastKnownGood: current,
      lastPromotedGood: current,
      lastObservedSuspiciousSignature: null,
    }),
  );
  return true;
}

export async function recoverConfigFromLastKnownGoodCore(params: {
  deps: ObserveRecoveryDeps;
  snapshot: ConfigFileSnapshot;
  reason: string;
  prepareCandidate: PrepareConfigRecoveryCandidate;
}): Promise<boolean> {
  const { deps, snapshot } = params;
  if (!snapshot.exists || typeof snapshot.raw !== "string") {
    return false;
  }
  if (!shouldAttemptLastKnownGoodRecovery(snapshot)) {
    if (isPluginLocalInvalidConfigSnapshot(snapshot)) {
      deps.logger.warn(
        `Config last-known-good recovery skipped: invalidity is scoped to stale plugin config (${params.reason})`,
      );
    }
    return false;
  }
  const healthState = readConfigHealthStateFromStore(deps);
  const entry = readConfigHealthEntry(healthState, snapshot.path);
  const promoted = entry.lastPromotedGood;
  if (!promoted?.hash) {
    return false;
  }
  const lastGoodPath = resolveLastKnownGoodConfigPath(snapshot.path);
  const backupRaw = await deps.fs.promises.readFile(lastGoodPath, "utf-8").catch(() => null);
  if (!backupRaw || hashConfigRaw(backupRaw) !== promoted.hash) {
    return false;
  }
  let backupParsed: unknown;
  try {
    backupParsed = deps.json5.parse(backupRaw);
  } catch {
    return false;
  }
  // Historical bytes become live config only after their owner has migrated and validated them.
  // This prevents Doctor recovery from exposing a schema-invalid intermediate file.
  const originalCandidate = { raw: backupRaw, parsed: backupParsed };
  const prepared = params.prepareCandidate(originalCandidate);
  if (!prepared.ok) {
    deps.logger.warn(
      `Config last-known-good recovery skipped: ${prepared.reason} (${params.reason})`,
    );
    return false;
  }
  const recoveryCandidate = prepared.candidate;
  const polluted = collectPollutedSecretPlaceholders(recoveryCandidate.parsed);
  if (polluted.length > 0) {
    deps.logger.warn(
      `Config last-known-good recovery skipped: redacted secret placeholder at ${polluted[0]}`,
    );
    return false;
  }
  const now = new Date().toISOString();
  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const current = createConfigHealthFingerprint({
    hash: resolveConfigSnapshotHash(snapshot) ?? undefined,
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    resolved: snapshot.resolved,
    stat,
    observedAt: now,
  });
  const clobberedPath = await preserveConfigSnapshotAsClobberedCore({
    deps,
    snapshot,
    observedAt: now,
  });
  if (recoveryCandidate.raw !== backupRaw) {
    warnIfJSON5CommentsWillBeStripped({
      raw: backupRaw,
      filePath: snapshot.path,
      warn: (message) => deps.logger.warn(message),
    });
  }
  await createRecoveryCommitEffect({
    deps,
    configPath: snapshot.path,
    raw: recoveryCandidate.raw,
  }).async();
  await chmodConfigBestEffort({
    deps,
    configPath: snapshot.path,
    context: "last-known-good recovery",
  });
  const issueSummary = formatConfigIssueSummary([...snapshot.issues, ...snapshot.legacyIssues]);
  deps.logger.warn(
    `Config auto-restored from last-known-good: ${snapshot.path} (${params.reason})${issueSummary ? `; Rejected validation details: ${issueSummary}.` : ""}`,
  );
  await appendConfigAuditRecord(
    createConfigObserveAuditAppendParams(deps, {
      configPath: snapshot.path,
      valid: snapshot.valid,
      current,
      suspicious: [params.reason],
      lastKnownGood: promoted,
      backup: promoted,
      clobberedPath,
      restoredFromBackup: true,
      restoredBackupPath: lastGoodPath,
    }),
  );
  writeConfigHealthStateToStore(
    deps,
    updateConfigHealthEntry(healthState, snapshot.path, {
      ...entry,
      lastKnownGood: promoted,
      lastPromotedGood: promoted,
      lastObservedSuspiciousSignature: null,
    }),
  );
  return true;
}

async function preserveConfigSnapshotAsClobberedCore(params: {
  deps: ObserveRecoveryDeps;
  snapshot: ConfigFileSnapshot;
  observedAt?: string;
}): Promise<string | null> {
  if (!params.snapshot.exists || typeof params.snapshot.raw !== "string") {
    return null;
  }
  return await persistBoundedClobberedConfigSnapshot({
    deps: params.deps,
    configPath: params.snapshot.path,
    raw: params.snapshot.raw,
    observedAt: params.observedAt ?? new Date().toISOString(),
  });
}
