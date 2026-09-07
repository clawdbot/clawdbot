import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const text = z.string().min(1).max(4096);
const absolutePath = text.refine((value) => path.isAbsolute(value));
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const binding = {
  runId: z.uuid(),
  stateDir: absolutePath,
  configPath: absolutePath,
  profile: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/iu)
    .nullable(),
};
/** Canonical daemon-selected identity; never a command, credential or authority. */
export const RecoveryNativeIdentitySchema = z.discriminatedUnion("platform", [
  z.strictObject({ ...binding, platform: z.literal("win32"), taskName: text }),
  z.strictObject({ ...binding, platform: z.literal("darwin"), domain: text, label: text }),
  // Scope and the daemon-observed user-manager UID are identity, not defaults
  // derived from the updater process or enable policy. System scope has no UID.
  z.discriminatedUnion("scope", [
    z.strictObject({
      ...binding,
      platform: z.literal("linux"),
      scope: z.literal("user"),
      unitName: text,
      uid: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
    z.strictObject({
      ...binding,
      platform: z.literal("linux"),
      scope: z.literal("system"),
      unitName: text,
    }),
  ]),
]);
export const RecoveryNativeFactsSchema = z
  .strictObject({
    exists: z.boolean(),
    enabled: z.boolean().nullable(),
    loaded: z.boolean(),
    stopped: z.boolean(),
  })
  .refine((facts) =>
    facts.exists
      ? facts.enabled !== null && (facts.loaded || facts.stopped)
      : facts.enabled === null && !facts.loaded && facts.stopped,
  );
export const RecoveryNativeObservationSchema = z.strictObject({
  identity: RecoveryNativeIdentitySchema,
  facts: RecoveryNativeFactsSchema,
});
export const RecoveryNativeActionSchema = z.enum([
  "suppress",
  "stop",
  "restore",
  "enable-for-start",
]);
const effect = z.strictObject({
  effectId: z.uuid(),
  action: RecoveryNativeActionSchema,
  before: RecoveryNativeFactsSchema,
  after: RecoveryNativeFactsSchema,
  state: z.enum(["intent", "observed", "not-applied"]),
  intentRevision: revision,
  observedRevision: revision.optional(),
});
export const RecoveryNativeManagerSchema = z
  .strictObject({
    identity: RecoveryNativeIdentitySchema,
    original: RecoveryNativeFactsSchema,
    boundAtRevision: revision,
    effects: z.array(effect).max(128),
  })
  .superRefine((manager, ctx) => {
    let last = manager.boundAtRevision;
    const ids = new Set<string>();
    let previous = manager.original;
    for (const [index, entry] of manager.effects.entries()) {
      if (
        !isDeepStrictEqual(entry.before, previous) ||
        ids.has(entry.effectId) ||
        (entry.state === "not-applied" && isDeepStrictEqual(entry.before, entry.after)) ||
        entry.intentRevision <= last ||
        (entry.state === "intent"
          ? entry.observedRevision !== undefined || index !== manager.effects.length - 1
          : entry.observedRevision === undefined ||
            entry.observedRevision <= entry.intentRevision) ||
        !validNativeTransition(
          entry.action,
          entry.before,
          entry.after,
          manager.original,
          manager.identity.platform,
        )
      ) {
        ctx.addIssue({ code: "custom", message: "Invalid native manager effect history" });
      }
      ids.add(entry.effectId);
      previous = entry.state === "not-applied" ? entry.before : entry.after;
      last = entry.observedRevision ?? entry.intentRevision;
    }
  });
export type UpdateRecoveryNativeIdentity = z.infer<typeof RecoveryNativeIdentitySchema>;
export type UpdateRecoveryNativeFacts = z.infer<typeof RecoveryNativeFactsSchema>;
export type UpdateRecoveryNativeObservation = z.infer<typeof RecoveryNativeObservationSchema>;
export type UpdateRecoveryNativeAction = z.infer<typeof RecoveryNativeActionSchema>;

/** Native stop may unload or remain loaded, but cannot change enable policy or load a job. */
export function validNativeTransition(
  action: UpdateRecoveryNativeAction,
  before: UpdateRecoveryNativeFacts,
  after: UpdateRecoveryNativeFacts,
  original: UpdateRecoveryNativeFacts,
  platform: UpdateRecoveryNativeIdentity["platform"],
): boolean {
  if (action === "enable-for-start") {
    // Windows /Run and launchd bootstrap refuse disabled jobs. This is not
    // restored policy: only the captured running-but-disabled job may borrow enablement.
    return (
      (platform === "win32" || platform === "darwin") &&
      original.exists &&
      original.loaded &&
      !original.stopped &&
      original.enabled === false &&
      before.exists &&
      before.stopped &&
      before.enabled === false &&
      isDeepStrictEqual(after, { ...before, enabled: true })
    );
  }
  if (action === "restore") {
    if (!before.exists || !original.exists) {
      return isDeepStrictEqual(after, original);
    }
    // Restore the enable policy separately from load/start. In particular,
    // re-enabling a stopped Windows task does not prove a service restart.
    return (
      isDeepStrictEqual(after, { ...before, enabled: original.enabled }) ||
      isDeepStrictEqual(after, { ...before, loaded: original.loaded, stopped: original.stopped })
    );
  }
  if (!before.exists || !after.exists) {
    return isDeepStrictEqual(before, after);
  }
  return action === "suppress"
    ? after.enabled === false && before.loaded === after.loaded && before.stopped === after.stopped
    : after.stopped && after.enabled === before.enabled && (!after.loaded || before.loaded);
}

/** A rejected, settled native dispatch preserves its target as history but its
 * fresh before observation is the current fact. It is never a boot receipt. */
export function currentUpdateRecoveryNativeFacts(
  manager: z.infer<typeof RecoveryNativeManagerSchema>,
): UpdateRecoveryNativeFacts {
  const last = manager.effects.at(-1);
  return last?.state === "not-applied" ? last.before : (last?.after ?? manager.original);
}
