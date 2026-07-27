import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import { preflightPluginInstall } from "../plugins/plugin-install-preflight.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  digestClawPackageRef,
  replaceClawPackageRefExpected,
} from "./package-update-provenance.js";
import { installClawPackages } from "./packages.js";
import {
  CLAW_PACKAGE_REF_SCHEMA_VERSION,
  readClawPackageRefs,
  type PersistedClawPackageRef,
} from "./provenance.js";
import type { ClawAddPlan, ClawManifest, ClawPackage } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan.js";

type PackageInstallerDeps = NonNullable<
  NonNullable<Parameters<typeof installClawPackages>[1]>["deps"]
>;

export type ClawPackageUpdateExecution = {
  appliedIds: string[];
  rollback: () => Promise<void>;
};

export class ClawPackageUpdateError extends Error {
  constructor(
    message: string,
    readonly partial: boolean,
  ) {
    super(message);
    this.name = "ClawPackageUpdateError";
  }
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function packageKey(value: Pick<ClawPackage, "kind" | "ref">): string {
  return `${value.kind}:${value.ref}`;
}

export async function applyClawPackageUpdate(
  updatePlan: ClawUpdatePlan,
  targetManifest: ClawManifest,
  targetAddPlan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    installPackages?: typeof installClawPackages;
    readRefs?: typeof readClawPackageRefs;
    replaceExpected?: typeof replaceClawPackageRefExpected;
    packageDeps?: PackageInstallerDeps;
    nowMs?: number;
  },
): Promise<ClawPackageUpdateExecution> {
  const actions = updatePlan.actions.filter(
    (action) => action.kind === "package" && action.action !== "unchanged",
  );
  if (actions.length === 0) {
    return { appliedIds: [], rollback: async () => undefined };
  }
  const installPackages = options.installPackages ?? installClawPackages;
  const readRefs = options.readRefs ?? readClawPackageRefs;
  const replaceExpected = options.replaceExpected ?? replaceClawPackageRefExpected;
  const currentRefs = new Map(
    readRefs({ ...options, agentId: updatePlan.agentId }).map((ref) => [packageKey(ref), ref]),
  );
  const allRefs = readRefs(options);
  const targets = new Map(targetManifest.packages.map((pkg) => [packageKey(pkg), pkg]));
  const undo: Array<() => Promise<void>> = [];
  const externalMutations: string[] = [];
  const appliedIds: string[] = [];

  const rollback = async () => {
    const failures: string[] = [];
    for (const revert of undo.toReversed()) {
      try {
        await revert();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (externalMutations.length > 0) {
      failures.push(`package artifacts may have been retained: ${externalMutations.join(", ")}`);
    }
    if (failures.length > 0) {
      throw new ClawPackageUpdateError(failures.join("; "), externalMutations.length > 0);
    }
  };

  try {
    for (const action of actions) {
      const previous = currentRefs.get(action.id);
      if (
        previous &&
        action.currentDigest &&
        digestClawPackageRef(previous) !== action.currentDigest
      ) {
        throw new ClawPackageUpdateError(
          `Package reference ${JSON.stringify(action.id)} changed after planning.`,
          false,
        );
      }
      if (action.action === "release" || action.action === "remove") {
        if (!previous) {
          throw new ClawPackageUpdateError(
            `Package reference ${JSON.stringify(action.id)} disappeared.`,
            false,
          );
        }
        replaceExpected(previous, undefined, options);
        undo.push(async () => replaceExpected(undefined, previous, options));
        appliedIds.push(action.id);
        continue;
      }
      const target = targets.get(action.id);
      const targetAction = targetAddPlan.actions.find(
        (candidate) => candidate.kind === "package" && candidate.id === action.id,
      );
      if (!target || !targetAction) {
        throw new ClawPackageUpdateError(
          `Target package action ${JSON.stringify(action.id)} is missing.`,
          false,
        );
      }
      const targetIntegrity = targetAction.details?.integrity;
      if (typeof targetIntegrity !== "string") {
        throw new ClawPackageUpdateError(
          `Target package action ${JSON.stringify(action.id)} has no resolved integrity.`,
          false,
        );
      }
      if (
        target.kind === "plugin" &&
        allRefs.some(
          (ref) =>
            ref.agentId !== updatePlan.agentId &&
            ref.kind === "plugin" &&
            ref.source === target.source &&
            ref.ref === target.ref &&
            ref.version !== target.version,
        )
      ) {
        throw new ClawPackageUpdateError(
          `Plugin ${JSON.stringify(target.ref)} has another Claw owner pinned to a different version.`,
          false,
        );
      }
      const nowMs = options.nowMs ?? Date.now();
      const reusesExistingArtifact = targetAction.details?.ownerAction === "reuse";
      let claimed: PersistedClawPackageRef = {
        schemaVersion: CLAW_PACKAGE_REF_SCHEMA_VERSION,
        agentId: updatePlan.agentId,
        clawName: targetAddPlan.claw.name,
        kind: target.kind,
        source: target.source,
        ref: target.ref,
        version: target.version,
        integrity: targetIntegrity,
        status: "pending",
        relationship: target.kind === "skill" ? "managed" : "referenced",
        origin: reusesExistingArtifact ? "pre-existing" : "claw-introduced",
        independentOwner: reusesExistingArtifact,
        installedAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      replaceExpected(previous, claimed, options);
      undo.push(async () => replaceExpected(claimed, previous, options));
      const refs = await installPackages(
        { ...targetAddPlan, actions: [targetAction] },
        {
          ...options,
          deps: {
            ...options.packageDeps,
            preflightPlugin: async (params) => {
              const preflight = await (
                options.packageDeps?.preflightPlugin ?? preflightPluginInstall
              )(params);
              const conflictingOwner = readRefs(options).some(
                (ref) =>
                  ref.agentId !== updatePlan.agentId &&
                  ref.kind === "plugin" &&
                  ref.source === target.source &&
                  ref.ref === target.ref &&
                  ref.version !== target.version,
              );
              return !preflight.ok &&
                preflight.code === "plugin_version_conflict" &&
                !conflictingOwner &&
                previous?.origin === "claw-introduced" &&
                !previous.independentOwner &&
                previous.version === preflight.installedVersion &&
                target.version === preflight.expectedVersion
                ? { ok: true, action: "install", request: preflight.request }
                : preflight;
            },
            persistPackageRef: (_plan, _pkg, persistOptions) => {
              const next = {
                ...claimed,
                status: persistOptions?.status ?? "complete",
                relationship: persistOptions?.relationship ?? claimed.relationship,
                origin: persistOptions?.origin ?? claimed.origin,
                independentOwner: persistOptions?.independentOwner ?? claimed.independentOwner,
                updatedAtMs: nowMs,
              };
              replaceExpected(claimed, next, options);
              claimed = next;
              return next;
            },
            completePackageRef: (ref, status) => {
              const next = { ...ref, status, updatedAtMs: nowMs };
              replaceExpected(claimed, next, options);
              claimed = next;
              return next;
            },
          },
          onExternalMutation: () => {
            externalMutations.push(`${target.kind}:${target.ref}@${target.version}`);
          },
        },
      );
      const installed = refs.find(
        (ref) => packageKey(ref) === action.id && ref.version === target.version,
      );
      if (!installed) {
        throw new ClawPackageUpdateError(
          `Package installer did not return exact ownership for ${JSON.stringify(action.id)}.`,
          true,
        );
      }
      if (digest(installed) !== digest(claimed)) {
        replaceExpected(claimed, installed, options);
        claimed = installed;
      }
      appliedIds.push(action.id);
    }
  } catch (error) {
    if (externalMutations.length > 0) {
      throw new ClawPackageUpdateError(
        `${error instanceof Error ? error.message : String(error)}; package artifact outcome requires reconciliation`,
        true,
      );
    }
    try {
      await rollback();
    } catch (rollbackError) {
      throw new ClawPackageUpdateError(
        `${error instanceof Error ? error.message : String(error)}; rollback incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        externalMutations.length > 0,
      );
    }
    throw new ClawPackageUpdateError(
      error instanceof Error ? error.message : String(error),
      error instanceof ClawPackageUpdateError ? error.partial : false,
    );
  }
  return { appliedIds, rollback };
}
