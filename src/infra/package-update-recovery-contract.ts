import path from "node:path";
import { z } from "zod";

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
