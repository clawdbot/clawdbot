/** Read-only recovery inventory and dependency classification; never deletion authority. */
import fs from "node:fs";
import path from "node:path";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { resolveStateDir } from "../config/paths.js";
import { isMigrationArchiveArtifactName } from "../config/sessions/artifacts.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  isPendingMigrationArtifactClaim,
  sameMigrationArtifact,
  statMigrationPath,
  type MigrationArtifact,
} from "./doctor-session-sqlite-artifact.js";
import {
  canonicalMigrationFilePath,
  hasSymbolicLinkInDirectoryPath,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
  resolveSessionSqliteMigrationRunsDir,
  uniqueRestoreMoves,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
  type SessionSqliteMigrationTargetManifest,
} from "./doctor-session-sqlite-migration-run.js";
import { collectRecordedConsumedArchives } from "./doctor-session-sqlite-restore.js";
import { isSessionSqliteMigrationWarning } from "./doctor-session-sqlite-types.js";

type Outcome =
  | "candidate"
  | "verification-required"
  | "protected"
  | "blocked"
  | "removed"
  | "disposed"
  | "failed";
type RecoveryCleanupArtifact = {
  path: string;
  runs: string[];
  bytes: number;
  outcome: Outcome;
  reason: string;
  detail?: string;
  consequence?: string;
  removedBytes?: number;
};
export type RecoveryCleanupReport = {
  stateDir: string;
  artifacts: RecoveryCleanupArtifact[];
  totals: {
    candidateBytes: number;
    verificationRequiredBytes: number;
    protectedBytes: number;
    blockedBytes: number;
    removedBytes: number;
    removedFiles: number;
  };
  status: "preview" | "refused" | "complete" | "blocked";
};
export type RecoveryArtifactReference = {
  run: ActiveSessionSqliteMigrationRun;
  target: SessionSqliteMigrationTargetManifest;
  move: SessionSqliteMigrationMove;
  trusted: boolean;
  consumedByRestore: boolean;
};
type RecoveryInventory = {
  report: RecoveryCleanupReport;
  references: Map<string, RecoveryArtifactReference[]>;
  manifestPaths: string[];
};

export function resolveRecoveryArtifact(
  refs: RecoveryArtifactReference[],
): MigrationArtifact | undefined {
  return (
    refs.find((ref) => ref.move.artifact?.disposal.state === "pending-disposal")?.move.artifact ??
    refs[0]?.move.artifact
  );
}

export function collectRecoveryInventory(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): RecoveryInventory {
  const stateDir = canonicalMigrationFilePath(path.join(resolveStateDir(params.env), "anchor"));
  const root = path.dirname(stateDir);
  const stores = new Set<string>();
  const archiveDirs = new Set<string>();
  const agentIds = new Set(listAgentIds(params.cfg));
  const agentsRoot = path.join(root, "agents");
  if (statMigrationPath(agentsRoot)?.isDirectory() && !hasSymbolicLinkInDirectoryPath(agentsRoot)) {
    for (const item of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (item.isDirectory()) {
        agentIds.add(item.name);
        stores.add(path.join(agentsRoot, item.name, "sessions", "sessions.json"));
      }
    }
  }
  for (const agentId of agentIds) {
    stores.add(
      canonicalMigrationFilePath(
        resolveSessionStorePathCore(params.cfg.session?.store, { agentId, env: params.env }),
      ),
    );
  }
  stores.add(path.join(root, "sessions", "sessions.json"));
  for (const store of stores) {
    if (isPathInside(root, store)) {
      archiveDirs.add(
        path.join(path.dirname(path.dirname(store)), "session-sqlite-import-archive"),
      );
    }
  }
  const references = new Map<string, RecoveryArtifactReference[]>();
  const manifestPaths: string[] = [];
  const artifacts: RecoveryCleanupArtifact[] = [];
  const manifestsDir = resolveSessionSqliteMigrationRunsDir(params.env);
  if (hasSymbolicLinkInDirectoryPath(manifestsDir)) {
    artifacts.push({
      path: manifestsDir,
      runs: [],
      bytes: 0,
      outcome: "blocked",
      reason: "manifest-directory-alias",
    });
  } else {
    manifestPaths.push(...listSessionSqliteMigrationManifestPaths(params.env));
    for (const manifestPath of manifestPaths) {
      const stat = statMigrationPath(manifestPath);
      const manifest =
        stat?.isFile() && stat.nlink === 1
          ? readSessionSqliteMigrationManifest(manifestPath)
          : undefined;
      if (!manifest) {
        artifacts.push({
          path: manifestPath,
          runs: [],
          bytes: stat?.size ?? 0,
          outcome: "blocked",
          reason: "unreadable-manifest",
        });
        continue;
      }
      const run = { manifest, manifestPath };
      const consumed = collectRecordedConsumedArchives(manifest);
      for (const target of manifest.targets) {
        const expected = resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath);
        const trusted =
          stores.has(target.storePath) &&
          isPathInside(root, target.sqlitePath) &&
          isPathInside(root, target.storePath) &&
          !hasSymbolicLinkInDirectoryPath(path.dirname(target.storePath)) &&
          !hasSymbolicLinkInDirectoryPath(path.dirname(target.sqlitePath)) &&
          (expected.agentId
            ? target.sqlitePath === expected.path && target.agentId === expected.agentId
            : path.dirname(target.sqlitePath) === path.dirname(expected.path));
        for (const move of uniqueRestoreMoves(target)) {
          const refs = references.get(move.archivePath) ?? [];
          refs.push({
            run,
            target,
            move,
            trusted,
            consumedByRestore: consumed.has(move.archivePath),
          });
          references.set(move.archivePath, refs);
        }
      }
    }
  }
  for (const [archivePath, refs] of references) {
    const evidence = resolveRecoveryArtifact(refs);
    const stat = refs.every((ref) => ref.trusted)
      ? fs.lstatSync(archivePath, { bigint: true, throwIfNoEntry: false })
      : undefined;
    const claim =
      refs.every((ref) => ref.trusted) && evidence?.disposal.state === "pending-disposal"
        ? fs.lstatSync(evidence.disposal.claimPath, { bigint: true, throwIfNoEntry: false })
        : undefined;
    const current = stat ?? claim;
    const item: RecoveryCleanupArtifact = {
      path: archivePath,
      runs: [...new Set(refs.map((ref) => ref.run.manifest.runId))],
      bytes: current?.isFile() ? Number(current.size) : (evidence?.identity.size ?? 0),
      outcome: "candidate",
      reason: "producer-verified-original",
      consequence:
        "Permanently loses rollback to this original, including pre-repair branches and metadata.",
    };
    if (refs.some((ref) => !ref.trusted)) {
      item.outcome = "protected";
      item.reason = "unsupported-target-ownership";
    } else if (refs.every((ref) => ref.move.artifact?.disposal.state === "disposed")) {
      item.outcome = stat ? "protected" : "disposed";
      item.reason = stat ? "recreated-after-disposal" : "intentionally-disposed";
    } else if (refs.some((ref) => ref.consumedByRestore)) {
      item.outcome = "protected";
      item.reason = "archive-consumed-by-restore";
    } else if (
      hasSymbolicLinkInDirectoryPath(path.dirname(archivePath)) ||
      (stat &&
        (!stat.isFile() ||
          (stat.nlink !== 1n && !isPendingMigrationArtifactClaim(archivePath, evidence))))
    ) {
      item.outcome = "blocked";
      item.reason = "artifact-alias-or-nonregular";
    } else if (
      refs.some(
        ({ run, target }) =>
          !run.manifest.completedAt ||
          target.validationBeforeArchive !== "passed" ||
          target.issues.some((issue) => !isSessionSqliteMigrationWarning(issue)),
      )
    ) {
      item.outcome = "protected";
      item.reason = "incomplete-recovery-operation";
    } else if (refs.some(({ move }) => move.artifact?.classification === "protected")) {
      item.outcome = "protected";
      item.reason = refs.find(
        (ref) => ref.move.artifact?.classification === "protected",
      )!.move.artifact!.reason;
    } else if (refs.some(({ move }) => !move.artifact)) {
      item.outcome = "verification-required";
      item.reason = "historical-manifest-without-import-proof";
    } else if (
      current &&
      evidence &&
      (["dev", "ino", "mtimeNs", "size"] as const).some(
        (key) => String(current[key]) !== String(evidence.identity[key]),
      )
    ) {
      // Preview can reject changed metadata without reading history; apply still verifies content.
      item.outcome = "blocked";
      item.reason = "artifact-metadata-changed";
    } else if (
      refs.some(({ move }) => !sameMigrationArtifact(move.artifact!.identity, evidence!.identity))
    ) {
      item.outcome = "blocked";
      item.reason = "conflicting-artifact-identities";
    } else if (
      refs.some(({ move }) => {
        const receipt = move.artifact?.disposal;
        return (
          receipt?.state === "pending-disposal" &&
          evidence?.disposal.state === "pending-disposal" &&
          receipt.claimPath !== evidence.disposal.claimPath
        );
      })
    ) {
      item.outcome = "blocked";
      item.reason = "conflicting-disposal-claims";
    } else if (
      !stat &&
      !refs.every(
        ({ move }) =>
          move.artifact?.disposal.state === "pending-disposal" ||
          move.artifact?.disposal.state === "disposed",
      )
    ) {
      item.outcome = "blocked";
      item.reason = "unexpectedly-missing-artifact";
    } else if (refs.some(({ move }) => move.artifact?.disposal.state === "pending-disposal")) {
      item.reason = "resume-pending-disposal";
    }
    artifacts.push(item);
  }
  for (const store of stores) {
    const directory = path.dirname(store);
    if (
      !isPathInside(root, directory) ||
      !statMigrationPath(directory)?.isDirectory() ||
      hasSymbolicLinkInDirectoryPath(directory)
    ) {
      continue;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!isMigrationArchiveArtifactName(entry.name) && !entry.name.includes(".pre-doctor-")) {
        continue;
      }
      const filePath = path.join(directory, entry.name);
      artifacts.push({
        path: filePath,
        runs: [],
        bytes: entry.isFile() ? fs.lstatSync(filePath).size : 0,
        outcome: "protected",
        reason: "unmanifested-recovery-original",
      });
    }
  }
  // Unknown files in known archive directories are visible, with no authority inferred from names.
  for (const directory of archiveDirs) {
    if (!statMigrationPath(directory)?.isDirectory() || hasSymbolicLinkInDirectoryPath(directory)) {
      continue;
    }
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, item.name);
      if (references.has(filePath) || artifacts.some((artifact) => artifact.path === filePath)) {
        continue;
      }
      if (
        [...references.values()].some((refs) =>
          refs.some(
            ({ move }) =>
              move.artifact?.disposal.state === "pending-disposal" &&
              move.artifact.disposal.claimPath === filePath,
          ),
        )
      ) {
        continue;
      }
      artifacts.push({
        path: filePath,
        runs: [],
        bytes: item.isFile() ? fs.lstatSync(filePath).size : 0,
        outcome: "protected",
        reason: "unmanifested-artifact",
      });
    }
  }
  if (
    artifacts.some(
      (item) => item.reason === "unreadable-manifest" || item.reason === "manifest-directory-alias",
    )
  ) {
    for (const item of artifacts) {
      if (item.outcome === "candidate" || item.outcome === "verification-required") {
        item.outcome = "blocked";
        item.reason = "unreadable-recovery-dependencies";
      }
    }
  }
  protectRecoveryDependencies(artifacts, references);
  return {
    references,
    manifestPaths,
    report: summarizeRecoveryCleanup(root, artifacts, "preview"),
  };
}

export function protectRecoveryDependencies(
  artifacts: RecoveryCleanupArtifact[],
  refs: Map<string, RecoveryArtifactReference[]>,
  adoptions?: ReadonlyMap<RecoveryArtifactReference, MigrationArtifact>,
): void {
  const active = (ref: RecoveryArtifactReference) =>
    (!ref.consumedByRestore || statMigrationPath(ref.move.archivePath) !== undefined) &&
    ref.move.artifact?.disposal.state !== "disposed";
  const bySource = new Map<string, string[]>();
  const dependents = new Map<string, Set<string>>();
  for (const [archive, references] of refs) {
    for (const ref of references.filter(active)) {
      const paths = bySource.get(ref.move.sourcePath) ?? [];
      paths.push(archive);
      bySource.set(ref.move.sourcePath, paths);
    }
  }
  const connect = (from: string, to: string) => {
    const paths = dependents.get(from) ?? new Set<string>();
    paths.add(to);
    dependents.set(from, paths);
  };
  for (const [archive, references] of refs) {
    for (const ref of references.filter(active)) {
      const moves = uniqueRestoreMoves(ref.target);
      const dependencies =
        (ref.move.artifact ?? adoptions?.get(ref))?.dependencies ??
        (ref.move.kind === "legacy-store"
          ? moves.filter((move) => move.kind === "transcript").map((move) => move.sourcePath)
          : []);
      for (const source of dependencies) {
        for (const dependency of bySource.get(source) ?? []) {
          connect(archive, dependency);
          // A retained transcript needs its index even when a prior run published it.
          // Consumed restore receipts are settled generations, not retained payload dependencies.
          if (ref.move.kind === "legacy-store") {
            connect(dependency, archive);
          }
        }
      }
    }
  }
  const byPath = new Map(artifacts.map((item) => [item.path, item]));
  const retained = artifacts.filter(
    (item) =>
      item.outcome !== "candidate" &&
      item.outcome !== "verification-required" &&
      item.outcome !== "disposed" &&
      item.outcome !== "removed",
  );
  // Newly protected artifacts join this queue so retention propagates transitively.
  for (const item of retained) {
    for (const dependency of dependents.get(item.path) ?? []) {
      const candidate = byPath.get(dependency);
      if (candidate?.outcome !== "candidate" && candidate?.outcome !== "verification-required") {
        continue;
      }
      candidate.outcome = "protected";
      candidate.reason = "retained-recovery-dependency";
      retained.push(candidate);
    }
  }
}

export function summarizeRecoveryCleanup(
  stateDir: string,
  artifacts: RecoveryCleanupArtifact[],
  status: RecoveryCleanupReport["status"],
): RecoveryCleanupReport {
  const totals = {
    candidateBytes: 0,
    verificationRequiredBytes: 0,
    protectedBytes: 0,
    blockedBytes: 0,
    removedBytes: 0,
    removedFiles: 0,
  };
  for (const item of artifacts) {
    if (item.outcome === "candidate") {
      totals.candidateBytes += item.bytes;
    }
    if (item.outcome === "verification-required") {
      totals.verificationRequiredBytes += item.bytes;
    }
    if (item.outcome === "protected") {
      totals.protectedBytes += item.bytes;
    }
    if (item.outcome === "blocked" || item.outcome === "failed") {
      totals.blockedBytes += item.bytes;
    }
    if (item.removedBytes !== undefined) {
      totals.removedBytes += item.removedBytes;
      totals.removedFiles += 1;
    }
  }
  return { stateDir, artifacts, totals, status };
}

export function inspectSessionSqliteRecovery(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): RecoveryCleanupReport {
  return collectRecoveryInventory(params).report;
}
