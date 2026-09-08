import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "./errors.js";
import {
  copyPackagePathEntry,
  removePackagePath,
  restoreNpmPackageRoot,
} from "./package-update-filesystem.js";
import {
  createPackageIntegrityReader,
  verifyPackageRecoveryMaterial,
} from "./package-update-integrity.js";
import {
  PackageTransactionDescriptorSchema,
  type PackageTransactionDescriptor,
  type PackageRetentionDecision,
  type PackageRecoveryVerified,
  type PackageRecoveryResult,
  PackageRecoveryEffectSchema,
  type PackageRecoveryEffect,
  type PackageRecoveryEffectReceipt,
  type PackageRecoveryHooks,
  type PackageRecoveryObservation,
  type PackageRecoveryFacts,
} from "./package-update-recovery-contract.js";
export {
  PackageTransactionDescriptorSchema,
  PackageRecoveryEffectSchema,
} from "./package-update-recovery-contract.js";
export type {
  PackageTransactionDescriptor,
  PackageRetentionDecision,
  PackageRecoveryVerified,
  PackageRecoveryResult,
  PackageRecoveryEffect,
  PackageRecoveryEffectReceipt,
  PreparePackageRecovery,
  PackageRecoveryHooks,
} from "./package-update-recovery-contract.js";

class PackageRecoveryConflict extends Error {}

function conflict(message: string): never {
  throw new PackageRecoveryConflict(message);
}

function parsePackageTransactionDescriptor(input: unknown): PackageTransactionDescriptor {
  let value = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input) > 1024 * 1024) {
      throw new Error("Package transaction descriptor exceeds 1 MiB");
    }
    value = JSON.parse(input);
  }
  const parsed = PackageTransactionDescriptorSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(parsed)) > 1024 * 1024) {
    throw new Error("Package transaction descriptor exceeds 1 MiB");
  }
  return parsed;
}

export function createPackageRecoveryTransaction(
  input: PackageTransactionDescriptor,
  hooks: PackageRecoveryHooks,
  timeoutMs?: number,
  pendingInput?: PackageRecoveryEffect,
) {
  let descriptor = parsePackageTransactionDescriptor(input);
  if (hooks.transactionId !== descriptor.transactionId) {
    conflict("Recovery transaction changed");
  }
  let pendingEffect = pendingInput ? structuredClone(pendingInput) : null;
  let busy = false;
  let activating = false;
  let facts: PackageRecoveryFacts = { roots: [], launchers: [] };
  const displacedRoot = `${descriptor.backupRoot}.candidate`;
  const launcherPath = (name: string) => path.join(descriptor.binDir, name);
  const backupLauncher = (name: string) =>
    descriptor.shimBackupRoot ? path.join(descriptor.shimBackupRoot, name) : null;

  async function observe(next = descriptor): Promise<PackageRecoveryVerified> {
    facts = { roots: [], launchers: [] };
    const reader = createPackageIntegrityReader(timeoutMs);
    return await reader.observe("transaction", async () => {
      const observation: PackageRecoveryObservation = {
        previous: "absent",
        candidate: "absent",
        launchers: "mixed",
        successorLive: false,
      };
      const roles = [
        [next.liveRoot, "live", "live"],
        [next.backupRoot, "retained", null],
        [next.stageRoot, null, "staged"],
        [displacedRoot, null, "displaced"],
      ] as const;
      // The fixed role set shares one unchanged deadline. Join every observation
      // before interpreting it or calling a durable/effect hook; a slow live tree
      // must not consume the candidate tree's whole opportunity to be inspected.
      const roots = await Promise.allSettled(
        roles.map(async ([root]) => {
          if (!(await reader.exists(root))) {
            return null;
          }
          const identity = await reader.directoryIdentity(root);
          const tree = await reader.tree(root, next.liveRoot);
          return { identity, tree };
        }),
      );
      for (const [index, [root, previousRole, candidateRole]] of roles.entries()) {
        const fact: PackageRecoveryFacts["roots"][number] = {
          path: root,
          identity: null,
          match: "unavailable",
        };
        facts.roots.push(fact);
        const result = roots[index]!;
        if (result.status === "rejected") {
          throw result.reason;
        }
        if (!result.value) {
          fact.match = "absent";
          continue;
        }
        fact.identity = result.value.identity;
        const actual = result.value.tree;
        if (previousRole && next.previous && isDeepStrictEqual(actual, next.previous)) {
          if (observation.previous !== "absent") {
            conflict("Previous package appears in multiple roles");
          }
          observation.previous = previousRole;
          fact.match = "previous";
        } else if (candidateRole && isDeepStrictEqual(actual, next.candidate)) {
          if (observation.candidate !== "absent") {
            conflict("Candidate package appears in multiple roles");
          }
          observation.candidate = candidateRole;
          fact.match = "candidate";
        } else if (
          root === next.liveRoot &&
          next.retention?.state === "superseded" &&
          isDeepStrictEqual(actual, next.retention.replacement.live)
        ) {
          observation.successorLive = true;
          fact.match = "successor";
        } else {
          fact.match = "conflict";
          conflict(`Package generation changed at ${root}`);
        }
      }
      const retiring = next.retention !== null && next.retention.state !== "selected";
      if (next.shimBackupRoot && (await reader.exists(next.shimBackupRoot))) {
        if ((await reader.directoryIdentity(next.shimBackupRoot)) !== next.shimBackupIdentity) {
          conflict("Retained launcher directory identity changed");
        }
        const names = await reader.entries(next.shimBackupRoot, 64);
        const expected = next.launchers
          .filter((entry) => entry.previous !== null)
          .map((entry) => entry.name)
          .toSorted();
        if (
          names.some((name) => !expected.includes(name)) ||
          (!retiring && !isDeepStrictEqual(names, expected))
        ) {
          conflict("Retained launcher inventory changed");
        }
      }
      if (
        next.previous &&
        observation.previous === "absent" &&
        next.retention?.state !== "superseded"
      ) {
        throw new Error("Previous package recovery material is unavailable");
      }
      if (
        next.retention?.state === "unselected" &&
        next.previous &&
        observation.previous !== "live"
      ) {
        conflict("Unselected cleanup requires the previous package to be restored live");
      }
      let previousLaunchers = true;
      let candidateLaunchers = true;
      let interruptedLauncher = false;
      for (const entry of next.launchers) {
        const destination = launcherPath(entry.name);
        const actual = (await reader.exists(destination))
          ? await reader.launcher(destination)
          : null;
        previousLaunchers &&= actual === entry.previous;
        candidateLaunchers &&= actual === entry.candidate;
        const missingDuringEffect =
          actual === null &&
          (pendingEffect?.action === "restore" ||
            pendingEffect?.action === "activate" ||
            next.interruptedLaunchers.includes(entry.name));
        facts.launchers.push({
          name: entry.name,
          match:
            actual === entry.previous && actual === entry.candidate
              ? "both"
              : actual === entry.previous
                ? "previous"
                : actual === entry.candidate
                  ? "candidate"
                  : actual === null
                    ? "absent"
                    : "conflict",
        });
        if (actual !== entry.previous && actual !== entry.candidate && !observation.successorLive) {
          if (!missingDuringEffect) {
            conflict(`Package launcher changed at ${destination}`);
          }
          interruptedLauncher = true;
        }
        const backup = backupLauncher(entry.name);
        if (!retiring || (backup && (await reader.exists(backup)))) {
          if (
            entry.previous !== null &&
            (!backup || (await reader.launcher(backup)) !== entry.previous)
          ) {
            conflict(`Retained launcher changed: ${entry.name}`);
          }
        }
      }
      observation.launchers = interruptedLauncher
        ? "interrupted"
        : previousLaunchers && candidateLaunchers
          ? "both"
          : previousLaunchers
            ? "previous"
            : candidateLaunchers
              ? "candidate"
              : "mixed";
      if (next.retention?.state === "superseded") {
        const replacement = next.retention.replacement;
        if (
          new Set(replacement.launchers.map((entry) => entry.name)).size !==
            replacement.launchers.length ||
          next.launchers.some(
            (entry) => !replacement.launchers.some((live) => live.name === entry.name),
          )
        ) {
          conflict("Superseding launcher inventory is incomplete");
        }
        for (const entry of replacement.launchers) {
          if ((await reader.launcher(launcherPath(entry.name))) !== entry.fingerprint) {
            conflict("Superseding launcher identity changed");
          }
        }
        if (
          !observation.successorLive ||
          replacement.retainedRoot === next.liveRoot ||
          replacement.retainedRoot === next.backupRoot ||
          replacement.retainedRoot === displacedRoot ||
          path.dirname(replacement.retainedRoot) !== path.dirname(next.backupRoot) ||
          !path.basename(replacement.retainedRoot).startsWith(".openclaw.package-backup-") ||
          replacement.retained.identity === replacement.live.identity ||
          !isDeepStrictEqual(
            await reader.tree(replacement.retainedRoot, next.liveRoot),
            replacement.retained,
          )
        ) {
          conflict("Superseding live/retained package pair is not verified");
        }
      }
      const snapshot = structuredClone(next);
      return {
        status: "verified",
        descriptor: snapshot,
        observation,
        observedIdentity: createHash("sha256")
          .update(JSON.stringify([snapshot, observation]))
          .digest("hex"),
      };
    });
  }

  async function attempt(
    operation: () => Promise<PackageRecoveryVerified>,
  ): Promise<PackageRecoveryResult> {
    if (busy || activating) {
      return failure(new PackageRecoveryConflict("Package recovery operation is already active"));
    }
    busy = true;
    try {
      return await operation();
    } catch (error) {
      return failure(error);
    } finally {
      busy = false;
    }
  }

  function failure(error: unknown): Exclude<PackageRecoveryResult, PackageRecoveryVerified> {
    return {
      status: error instanceof PackageRecoveryConflict ? "conflict" : "unavailable",
      reason: formatErrorMessage(error),
      descriptor: structuredClone(descriptor),
      pendingEffect: structuredClone(pendingEffect),
      facts: structuredClone(facts),
    };
  }

  async function intent(action: PackageRecoveryEffect["action"], next = descriptor) {
    if (
      pendingEffect &&
      (pendingEffect.action !== action || !isDeepStrictEqual(pendingEffect.descriptor, next))
    ) {
      conflict("Reconcile the outstanding package effect before starting another");
    }
    const observed = await observe(next);
    const mode = pendingEffect ? "resume" : "new";
    pendingEffect ??= { effectId: randomUUID(), action, descriptor: structuredClone(next) };
    // A callback can commit and then throw. Keep this exact attempt available
    // even when its acceptance is unknown; Recovery must resolve that ambiguity.
    descriptor = structuredClone(next);
    const receipt = await hooks.beforeEffect(structuredClone(pendingEffect), { mode, observed });
    receipt.assertCurrent();
    return receipt;
  }

  async function finish(
    receipt: PackageRecoveryEffectReceipt,
    next = descriptor,
    outcome: "completed" | "interrupted" = "completed",
  ) {
    const observed = await observe(next);
    receipt.assertCurrent();
    await receipt.afterEffect(observed, outcome);
    pendingEffect = null;
    descriptor = structuredClone(next);
    return observed;
  }

  return {
    descriptor: () => structuredClone(descriptor),
    pendingEffect: () => structuredClone(pendingEffect),
    observe: () => attempt(() => observe()),
    async prepare() {
      const receipt = await hooks.persistDescriptor(await observe());
      await observe();
      receipt.assertCurrent();
    },
    // Interrupted activation is observed as such before compensation gets its
    // own intent. This does not declare a partly activated package successful.
    reconcile: () =>
      attempt(async () => {
        if (!pendingEffect) {
          return observe();
        }
        if (pendingEffect.action !== "activate") {
          conflict("Resume the pending package operation");
        }
        const receipt = await intent("activate");
        const current = await observe();
        const completed =
          current.observation.candidate === "live" &&
          ["candidate", "both"].includes(current.observation.launchers);
        const next = {
          ...descriptor,
          interruptedLaunchers: completed
            ? []
            : facts.launchers
                .filter((entry) => entry.match === "absent")
                .map((entry) => entry.name),
        };
        return finish(receipt, next, completed ? "completed" : "interrupted");
      }),
    activationFailed: () => {
      activating = false;
    },
    async beforeActivation() {
      if (busy || activating) {
        conflict("Package recovery operation is already active");
      }
      activating = true;
      try {
        const observed = await observe();
        if (
          observed.observation.candidate !== "staged" ||
          observed.observation.previous !== (descriptor.previous ? "live" : "absent") ||
          !["previous", "both"].includes(observed.observation.launchers)
        ) {
          conflict("Package transaction is not in its admitted activation state");
        }
        const receipt = await intent("activate");
        // The awaited durable commit can outlive the prepared installation.
        if (!isDeepStrictEqual((await observe()).observation, observed.observation)) {
          conflict("Package roles changed during activation admission");
        }
        receipt.assertCurrent();
        return receipt;
      } catch (error) {
        activating = false;
        throw error;
      }
    },
    async afterActivation(receipt: PackageRecoveryEffectReceipt) {
      try {
        const observed = await observe();
        if (
          observed.observation.candidate !== "live" ||
          !["candidate", "both"].includes(observed.observation.launchers)
        ) {
          conflict("Package activation is not complete");
        }
        return await finish(receipt);
      } finally {
        activating = false;
      }
    },
    rollback: () =>
      attempt(async () => {
        if (descriptor.retention && descriptor.retention.state !== "selected") {
          conflict("Retired package transaction cannot be restored");
        }
        await observe();
        const receipt = await intent("restore");
        const current = await observe();
        if (
          current.observation.previous === (descriptor.previous ? "live" : "absent") &&
          current.observation.candidate !== "live" &&
          ["previous", "both"].includes(current.observation.launchers)
        ) {
          return finish(receipt, { ...descriptor, interruptedLaunchers: [] });
        }
        if (current.observation.previous === "retained") {
          await verifyPackageRecoveryMaterial({
            root: descriptor.backupRoot,
            originalRoot: descriptor.liveRoot,
            previous: descriptor.previous,
            launchers: descriptor.launchers.map((entry) => ({
              path: backupLauncher(entry.name),
              fingerprint: entry.previous,
            })),
            timeoutMs,
          });
          await restoreNpmPackageRoot({
            liveRoot: descriptor.liveRoot,
            backupRoot: descriptor.backupRoot,
            displacedRoot,
            candidatePresent: current.observation.candidate === "live",
            assertCurrent: receipt.assertCurrent,
          });
        } else if (!descriptor.previous && current.observation.candidate === "live") {
          receipt.assertCurrent();
          await fs.rename(descriptor.liveRoot, displacedRoot);
        }
        for (const entry of descriptor.launchers) {
          receipt.assertCurrent();
          const backup = backupLauncher(entry.name);
          if (entry.previous !== null && backup) {
            await copyPackagePathEntry(backup, launcherPath(entry.name), receipt.assertCurrent);
          } else {
            await removePackagePath(launcherPath(entry.name));
          }
        }
        await verifyPackageRecoveryMaterial({
          root: descriptor.liveRoot,
          originalRoot: descriptor.liveRoot,
          previous: descriptor.previous,
          phase: "restored",
          launchers: descriptor.launchers.map((entry) => ({
            path: launcherPath(entry.name),
            fingerprint: entry.previous,
          })),
          timeoutMs,
        });
        return finish(receipt, { ...descriptor, interruptedLaunchers: [] });
      }),
    retain: (decision: Extract<PackageRetentionDecision, { state: "selected" }>) =>
      attempt(async () => {
        if (pendingEffect) {
          conflict("Reconcile the outstanding package effect before selection");
        }
        if (
          !descriptor.previous ||
          (descriptor.retention && descriptor.retention.state !== "selected")
        ) {
          conflict("No previous package pair can be selected");
        }
        if (
          descriptor.retention &&
          (descriptor.retention.pairId !== decision.pairId ||
            decision.ownerRevision < descriptor.retention.ownerRevision)
        ) {
          conflict("Stale package retention selection");
        }
        await observe();
        const next = parsePackageTransactionDescriptor({ ...descriptor, retention: decision });
        const observed = await observe(next);
        // Persistence can commit before its response fails. Return the attempted
        // descriptor on failure; only Recovery can establish its durable acceptance.
        descriptor = next;
        const receipt = await hooks.persistDescriptor(observed);
        const current = await observe(next);
        receipt.assertCurrent();
        descriptor = next;
        return current;
      }),
    retire: (decision: Exclude<PackageRetentionDecision, { state: "selected" }>) =>
      attempt(async () => {
        if (decision.state === "unselected") {
          // Recovery must already have a terminal unselected decision. The
          // observed prior package must be absent or restored live, never deleted.
          if (
            descriptor.retention &&
            (descriptor.retention.state !== "unselected" ||
              decision.ownerRevision < descriptor.retention.ownerRevision)
          ) {
            conflict("A selected recovery pair cannot use unselected cleanup");
          }
        } else if (
          !descriptor.retention ||
          descriptor.retention.state === "unselected" ||
          descriptor.retention.pairId !== decision.pairId ||
          (!isDeepStrictEqual(descriptor.retention, decision) &&
            decision.ownerRevision <= descriptor.retention.ownerRevision) ||
          (descriptor.retention.state === "superseded" &&
            !isDeepStrictEqual(descriptor.retention, decision)) ||
          decision.replacement.pairId === decision.pairId ||
          decision.replacement.transactionId === descriptor.transactionId
        ) {
          conflict("Stale or missing superseded-pair decision");
        }
        const next = parsePackageTransactionDescriptor({ ...descriptor, retention: decision });
        await observe(next);
        const receipt = await intent("retire", next);
        const current = await observe(next);
        if (decision.state === "superseded" && current.observation.previous === "live") {
          conflict("The selected previous package is still live");
        }
        for (const root of [
          next.backupRoot,
          displacedRoot,
          next.shimBackupRoot,
          current.observation.candidate === "staged" ? next.stageRoot : null,
        ]) {
          if (root) {
            receipt.assertCurrent();
            await removePackagePath(root);
          }
        }
        return finish(receipt, next);
      }),
  };
}

export type PackageRecoveryTransaction = Pick<
  ReturnType<typeof createPackageRecoveryTransaction>,
  "descriptor" | "pendingEffect" | "observe" | "reconcile" | "rollback" | "retain" | "retire"
>;

/** Read-only reconciliation first; a fresh live owner is still required for effects. */
export async function reopenPackageUpdateTransaction(params: {
  descriptor: unknown;
  expectedLiveRoot: string;
  expectedBinDir: string;
  expectedTransactionId: string;
  pendingEffect?: unknown;
  hooks: PackageRecoveryHooks;
  timeoutMs?: number;
}): Promise<
  | { status: "ready"; transaction: PackageRecoveryTransaction; observed: PackageRecoveryVerified }
  | { status: "conflict" | "unavailable"; reason: string; pendingEffect: unknown }
> {
  let descriptor: PackageTransactionDescriptor;
  let pending: PackageRecoveryEffect | undefined;
  try {
    descriptor = parsePackageTransactionDescriptor(params.descriptor);
    if (params.pendingEffect != null) {
      const parsed = PackageRecoveryEffectSchema.parse(params.pendingEffect);
      if (!isDeepStrictEqual(parsed.descriptor, descriptor)) {
        conflict("Pending package descriptor changed");
      }
      pending = parsed;
    }
  } catch (error) {
    return {
      status: error instanceof PackageRecoveryConflict ? "conflict" : "unavailable",
      reason: formatErrorMessage(error),
      pendingEffect: params.pendingEffect,
    };
  }
  if (
    descriptor.liveRoot !== params.expectedLiveRoot ||
    descriptor.binDir !== params.expectedBinDir ||
    descriptor.transactionId !== params.expectedTransactionId ||
    descriptor.transactionId !== params.hooks.transactionId
  ) {
    return {
      status: "conflict",
      reason: "Package descriptor does not match the admitted resource",
      pendingEffect: params.pendingEffect,
    };
  }
  const transaction = createPackageRecoveryTransaction(
    descriptor,
    params.hooks,
    params.timeoutMs,
    pending,
  );
  const observed = await transaction.observe();
  return observed.status === "verified" ? { status: "ready", transaction, observed } : observed;
}
