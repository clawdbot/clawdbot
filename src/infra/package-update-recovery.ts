import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
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

const text = z.string().min(1).max(32_768);
const absolute = text.refine((value) => path.isAbsolute(value) && path.resolve(value) === value);
const launcherName = text.refine(
  (value) => value !== "." && value !== ".." && !/[\\/]/u.test(value),
);
const fingerprint = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  identity: z.string().regex(/^\d+:\d+$/u),
  version: text,
});
const selection = z.strictObject({
  pairId: z.uuid(),
  ownerRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const retention = z.discriminatedUnion("state", [
  selection.extend({ state: z.literal("selected") }),
  z.strictObject({
    state: z.literal("unselected"),
    ownerRevision: selection.shape.ownerRevision,
  }),
  selection.extend({
    state: z.literal("superseded"),
    replacement: z.strictObject({
      pairId: z.uuid(),
      transactionId: z.uuid(),
      live: fingerprint,
      retainedRoot: absolute,
      retained: fingerprint,
      launchers: z.array(z.strictObject({ name: launcherName, fingerprint: text })).max(64),
    }),
  }),
]);

/** Operational data for Recovery's store, not a sidecar or deletion authority. */
export const PackageTransactionDescriptorSchema = z
  .strictObject({
    version: z.literal(1),
    transactionId: z.uuid(),
    packageName: z
      .string()
      .regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu)
      .max(214),
    liveRoot: absolute,
    stageRoot: absolute,
    backupRoot: absolute,
    binDir: absolute,
    shimBackupRoot: absolute.nullable(),
    shimBackupIdentity: text.nullable(),
    previous: fingerprint.nullable(),
    candidate: fingerprint,
    launchers: z
      .array(
        z.strictObject({
          name: launcherName,
          previous: text.nullable(),
          candidate: text,
        }),
      )
      .max(64),
    // Missing launchers observed when a prior activation intent was reconciled
    // as interrupted. Clear only after verified restoration, not on a retry.
    interruptedLaunchers: z.array(launcherName).max(64),
    retention: retention.nullable(),
  })
  .superRefine((value, ctx) => {
    const parent = path.resolve(value.liveRoot, ...value.packageName.split("/").map(() => ".."));
    if (
      value.liveRoot === path.parse(value.liveRoot).root ||
      value.stageRoot === path.parse(value.stageRoot).root ||
      value.binDir === path.parse(value.binDir).root ||
      path.join(parent, value.packageName) !== value.liveRoot ||
      value.packageName === "." ||
      value.packageName === ".." ||
      (value.shimBackupRoot === null) !== (value.shimBackupIdentity === null) ||
      path.dirname(value.backupRoot) !== parent ||
      !path.basename(value.backupRoot).startsWith(".openclaw.package-backup-") ||
      value.stageRoot === value.liveRoot ||
      value.stageRoot.startsWith(`${value.liveRoot}${path.sep}`) ||
      value.liveRoot.startsWith(`${value.stageRoot}${path.sep}`) ||
      (value.shimBackupRoot !== null &&
        (path.dirname(value.shimBackupRoot) !== parent ||
          !path.basename(value.shimBackupRoot).startsWith(".openclaw.shim-backup-"))) ||
      value.launchers.some((entry) => entry.previous !== null && !value.shimBackupRoot) ||
      value.interruptedLaunchers.some(
        (name) => !value.launchers.some((entry) => entry.name === name),
      ) ||
      new Set(value.launchers.map((entry) => entry.name)).size !== value.launchers.length
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Invalid package recovery paths or launcher inventory",
      });
    }
  });

export type PackageTransactionDescriptor = z.infer<typeof PackageTransactionDescriptorSchema>;
export type PackageRetentionDecision = z.infer<typeof retention>;
export type PackageRecoveryObservation = {
  previous: "live" | "retained" | "absent";
  candidate: "live" | "staged" | "displaced" | "absent";
  launchers: "previous" | "candidate" | "both" | "mixed" | "interrupted";
  successorLive: boolean;
};
export type PackageRecoveryFacts = {
  roots: Array<{
    path: string;
    identity: string | null;
    match: "unavailable" | "absent" | "previous" | "candidate" | "successor" | "conflict";
  }>;
  launchers: Array<{
    name: string;
    match: "previous" | "candidate" | "both" | "absent" | "conflict";
  }>;
};
export type PackageRecoveryVerified = {
  // Verified package roles can include absence or an interrupted transition.
  // Neither this tag nor its digest attests a running or restartable service.
  status: "verified";
  descriptor: PackageTransactionDescriptor;
  observation: PackageRecoveryObservation;
  observedIdentity: string;
};
export type PackageRecoveryResult =
  | PackageRecoveryVerified
  | {
      status: "conflict" | "unavailable";
      reason: string;
      // Unavailability is NOT a no-effects assertion. A pending intent survives
      // failed writes and failed observation commits until Recovery reconciles it.
      descriptor: PackageTransactionDescriptor;
      pendingEffect: PackageRecoveryEffect | null;
      facts: PackageRecoveryFacts;
    };
export const PackageRecoveryEffectSchema = z.strictObject({
  effectId: z.uuid(),
  action: z.enum(["activate", "restore", "retire"]),
  descriptor: PackageTransactionDescriptorSchema,
});
export type PackageRecoveryEffect = z.infer<typeof PackageRecoveryEffectSchema>;
export type PackageRecoveryEffectReceipt = {
  // Recovery revalidates its current executor and durable revision here. This
  // is not writer containment; it must never be serialized with the descriptor.
  assertCurrent: () => void;
  afterEffect: (
    observed: PackageRecoveryVerified,
    outcome: "completed" | "interrupted",
  ) => Promise<void>;
};
/** The package owner supplies verified staging facts before any live mutation. */
export type PreparePackageRecovery = (
  source: Pick<PackageTransactionDescriptor, "liveRoot" | "stageRoot" | "previous" | "candidate">,
) => Promise<PackageRecoveryHooks>;

export type PackageRecoveryHooks = {
  transactionId: string;
  /** Persist package facts only. For selection, validate Recovery's ALREADY
   * committed terminal/selected-pair decision; this callback must not select it.
   */
  persistDescriptor: (
    observed: PackageRecoveryVerified,
  ) => Promise<Pick<PackageRecoveryEffectReceipt, "assertCurrent">>;
  /** New: await durable intent. Resume: reacquire the SAME outstanding intent,
   * checking its exact descriptor and current revision; never append another.
   * If observation committed but its acknowledgement failed, reconcile the
   * matching observed effect instead of recording its observation twice.
   * Both paths carry each returned Recovery revision forward in the live closure.
   */
  beforeEffect: (
    effect: PackageRecoveryEffect,
    context: { mode: "new" | "resume"; observed: PackageRecoveryVerified },
  ) => Promise<PackageRecoveryEffectReceipt>;
};

class PackageRecoveryConflict extends Error {}

function conflict(message: string): never {
  throw new PackageRecoveryConflict(message);
}

export function parsePackageTransactionDescriptor(input: unknown): PackageTransactionDescriptor {
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
    const observation: PackageRecoveryObservation = {
      previous: "absent",
      candidate: "absent",
      launchers: "mixed",
      successorLive: false,
    };
    for (const [root, previousRole, candidateRole] of [
      [next.liveRoot, "live", "live"],
      [next.backupRoot, "retained", null],
      [next.stageRoot, null, "staged"],
      [displacedRoot, null, "displaced"],
    ] as const) {
      const fact: PackageRecoveryFacts["roots"][number] = {
        path: root,
        identity: null,
        match: "unavailable",
      };
      facts.roots.push(fact);
      if (!(await reader.exists(root))) {
        fact.match = "absent";
        continue;
      }
      fact.identity = await reader.directoryIdentity(root);
      const actual = await reader.tree(root, next.liveRoot);
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
      const actual = (await reader.exists(destination)) ? await reader.launcher(destination) : null;
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
