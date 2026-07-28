import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { stableStringify } from "../agents/stable-stringify.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import type {
  ClawSetupTargetState,
  PersistedClawSetupPending,
  PersistedClawSetupState,
} from "./setup-state.js";
import { buildClawSetupPlan, type ClawSetupMaterialization } from "./setup.js";
import { MAX_CLAW_SETUP_RENDERED_SEED_BYTES } from "./source-limits.js";
import {
  CLAW_SETUP_SCHEMA_VERSION,
  type ClawDiagnostic,
  type ClawManifest,
  type ClawManifestV2,
  type ClawSourceIdentity,
} from "./types.js";
import type { ClawUpdateAction } from "./update-plan-types.js";

export type ClawSetupReconciliation = {
  currentSchemaDigest?: string;
  targetSchemaDigest?: string;
  answerDigest?: string;
  createdSeeds: string[];
  regeneratedSeeds: string[];
  preservedSeeds: string[];
  releasedSeeds: string[];
  actions: ClawUpdateAction[];
  blockers: ClawDiagnostic[];
  materialization?: ClawSetupMaterialization;
  targetState?: ClawSetupTargetState;
};

function blocker(code: string, path: string, message: string): ClawDiagnostic {
  return { level: "error", code, phase: "plan", path, message };
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function persistedAnswers(state: PersistedClawSetupState | undefined): Record<string, unknown> {
  return Object.fromEntries((state?.answers ?? []).map((answer) => [answer.id, answer.value]));
}

function suppliedAnswers(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : value === undefined
      ? {}
      : undefined;
}

export async function buildClawSetupReconciliation(params: {
  currentManifestSchemaVersion: number;
  currentSetup?: PersistedClawSetupState;
  currentPending?: PersistedClawSetupPending;
  targetManifest: ClawManifest;
  targetSource: Pick<ClawSourceIdentity, "name" | "version" | "packageRoot">;
  workspace: string;
  workspaceFiles: ReadonlyArray<{ path: string }>;
  answers?: unknown;
  clearAnswers?: readonly string[];
  regenerateSeeds?: readonly string[];
}): Promise<ClawSetupReconciliation> {
  const currentIsV2 = params.currentManifestSchemaVersion === CLAW_SETUP_SCHEMA_VERSION;
  const targetIsV2 = params.targetManifest.schemaVersion === CLAW_SETUP_SCHEMA_VERSION;
  if (currentIsV2 && !targetIsV2) {
    return {
      currentSchemaDigest: params.currentSetup?.setupSchemaDigest,
      createdSeeds: [],
      regeneratedSeeds: [],
      preservedSeeds: params.currentSetup?.seeds.map((seed) => seed.destination) ?? [],
      releasedSeeds: [],
      actions: [],
      blockers: [
        blocker(
          "setup_schema_downgrade_unsupported",
          "$.schemaVersion",
          "Updating a schema version 2 Claw to schema version 1 is unsupported; remove and add the older package instead.",
        ),
      ],
    };
  }
  if (!targetIsV2) {
    return {
      createdSeeds: [],
      regeneratedSeeds: [],
      preservedSeeds: [],
      releasedSeeds: [],
      actions: [],
      blockers: [],
    };
  }
  if (currentIsV2 && !params.currentSetup && !params.currentPending) {
    return {
      createdSeeds: [],
      regeneratedSeeds: [],
      preservedSeeds: [],
      releasedSeeds: [],
      actions: [],
      blockers: [
        blocker(
          "setup_state_missing",
          "$.setup",
          "The installed schema version 2 Claw is missing personalization state and must be reconciled before update.",
        ),
      ],
    };
  }
  if (params.currentSetup && params.currentSetup.status !== "complete") {
    return {
      currentSchemaDigest: params.currentSetup.setupSchemaDigest,
      createdSeeds: [],
      regeneratedSeeds: [],
      preservedSeeds: params.currentSetup.seeds.map((seed) => seed.destination),
      releasedSeeds: [],
      actions: [],
      blockers: [
        blocker(
          "setup_state_incomplete",
          "$.setup",
          "The installed Claw has incomplete personalization state and must be recovered before update.",
        ),
      ],
    };
  }

  const target = params.targetManifest as ClawManifestV2;
  const pendingMatchesTarget =
    !params.currentPending ||
    (params.currentPending.clawName === params.targetSource.name &&
      params.currentPending.clawVersion === params.targetSource.version);
  if (!pendingMatchesTarget) {
    return {
      currentSchemaDigest: params.currentSetup?.setupSchemaDigest,
      createdSeeds: [],
      regeneratedSeeds: [],
      preservedSeeds: params.currentSetup?.seeds.map((seed) => seed.destination) ?? [],
      releasedSeeds: [],
      actions: [],
      blockers: [
        blocker(
          "setup_update_pending_conflict",
          "$.setup",
          "A different personalization update is pending and must be recovered or removed first.",
        ),
      ],
    };
  }
  const currentSeeds = new Map(
    (params.currentSetup?.seeds ?? []).map((seed) => [seed.destination, seed] as const),
  );
  const targetDestinations = new Set(target.personalization.seeds.map((seed) => seed.destination));
  const createdSeeds = [...targetDestinations].filter(
    (destination) => !currentSeeds.has(destination),
  );
  const releasedSeeds = [...currentSeeds.keys()].filter(
    (destination) => !targetDestinations.has(destination),
  );
  const requestedRegeneration = new Set(params.regenerateSeeds ?? []);
  const regeneratedSeeds = [...requestedRegeneration].filter(
    (destination) => currentSeeds.has(destination) && targetDestinations.has(destination),
  );
  const preservedSeeds = [...targetDestinations].filter(
    (destination) => currentSeeds.has(destination) && !requestedRegeneration.has(destination),
  );
  const answers = suppliedAnswers(params.answers);
  const clearAnswers = new Set(params.clearAnswers ?? []);
  const blockers: ClawDiagnostic[] = [];
  if (!answers) {
    blockers.push(blocker("setup_answers_invalid", "$.answers", "Answers must be a JSON object."));
  }
  for (const destination of requestedRegeneration) {
    if (!currentSeeds.has(destination) || !targetDestinations.has(destination)) {
      blockers.push(
        blocker(
          "setup_seed_regeneration_unknown",
          "$.regenerateSeeds",
          `Personalization seed ${JSON.stringify(destination)} is not shared by the installed and target schemas.`,
        ),
      );
    }
  }

  const targetInputIds = new Set(target.setup.inputs.map((input) => input.id));
  for (const answerId of clearAnswers) {
    if (!targetInputIds.has(answerId)) {
      blockers.push(
        blocker(
          "setup_answer_unknown",
          `$.clearAnswers.${answerId}`,
          `Answer does not match a declared setup input ${JSON.stringify(answerId)}.`,
        ),
      );
    } else if (answers && Object.hasOwn(answers, answerId)) {
      blockers.push(
        blocker(
          "setup_answer_conflict",
          `$.clearAnswers.${answerId}`,
          `Answer ${JSON.stringify(answerId)} cannot be both set and cleared.`,
        ),
      );
    }
  }
  const mergedAnswers = Object.fromEntries(
    Object.entries({
      ...persistedAnswers(params.currentSetup),
      ...persistedAnswers(params.currentPending),
      ...answers,
    }).filter(([id]) => targetInputIds.has(id) && !clearAnswers.has(id)),
  );
  const setup = await buildClawSetupPlan({
    manifest: target,
    packageRoot: params.targetSource.packageRoot,
    answers: mergedAnswers,
    seedDestinations: new Set([...createdSeeds, ...regeneratedSeeds]),
  });
  blockers.push(...setup.plan.diagnostics);
  const activeInputIds = new Set(setup.plan.seeds.flatMap((seed) => seed.inputIds));
  for (const answerId of Object.keys(answers ?? {})) {
    if (!activeInputIds.has(answerId)) {
      blockers.push(
        blocker(
          "setup_answer_without_effect",
          `$.answers.${answerId}`,
          `Answer ${JSON.stringify(answerId)} is not used by a created or regenerated personalization seed in this operation.`,
        ),
      );
    }
  }
  for (const answerId of clearAnswers) {
    if (targetInputIds.has(answerId) && !activeInputIds.has(answerId)) {
      blockers.push(
        blocker(
          "setup_answer_without_effect",
          `$.clearAnswers.${answerId}`,
          `Cleared answer ${JSON.stringify(answerId)} is not used by a created or regenerated personalization seed in this operation.`,
        ),
      );
    }
  }

  const actions: ClawUpdateAction[] = [];
  let workspace: Awaited<ReturnType<typeof fsSafeRoot>> | undefined;
  try {
    const stat = await lstat(params.workspace);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      workspace = await fsSafeRoot(params.workspace, { hardlinks: "reject", symlinks: "reject" });
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      blockers.push(
        blocker(
          "setup_workspace_unsafe",
          "$.personalization.seeds",
          "The installed Claw workspace is unsafe to inspect for personalization updates.",
        ),
      );
    }
  }
  const managedPaths = new Set(params.workspaceFiles.map((file) => file.path));
  for (const seed of setup.plan.seeds) {
    const regeneration = requestedRegeneration.has(seed.destination);
    const pendingSeed = params.currentPending?.seeds.find(
      (candidate) => candidate.destination === seed.destination,
    );
    let occupied = managedPaths.has(seed.destination);
    let currentDigest: string | undefined;
    if (!occupied && workspace) {
      try {
        const exists = await workspace.exists(seed.destination);
        if (regeneration && exists) {
          const current = await workspace.read(seed.destination, {
            hardlinks: "reject",
            maxBytes: MAX_CLAW_SETUP_RENDERED_SEED_BYTES,
            symlinks: "reject",
          });
          currentDigest = digestBytes(current.buffer);
        } else if (exists && pendingSeed?.renderedDigest === seed.digest) {
          const current = await workspace.read(seed.destination, {
            hardlinks: "reject",
            maxBytes: MAX_CLAW_SETUP_RENDERED_SEED_BYTES,
            symlinks: "reject",
          });
          occupied = digestBytes(current.buffer) !== seed.digest;
        } else {
          occupied = exists;
        }
      } catch {
        occupied = true;
      }
    }
    if (regeneration && !currentDigest) {
      occupied = true;
    }
    const blocked = seed.blocked || occupied;
    if (occupied) {
      blockers.push(
        blocker(
          "setup_seed_ownership_conflict",
          `$.personalization.seeds.${seed.destination}`,
          regeneration
            ? `Personalization destination ${JSON.stringify(seed.destination)} is missing or unsafe to replace.`
            : `Personalization destination ${JSON.stringify(seed.destination)} already contains managed or local content and cannot be converted to user ownership.`,
        ),
      );
    }
    actions.push({
      kind: "personalizationSeed",
      id: seed.destination,
      action: blocked ? "manual" : regeneration ? "change" : "add",
      target: `${params.workspace}:${seed.destination}`,
      blocked,
      reason: blocked
        ? "The new personalization seed cannot be created safely."
        : regeneration
          ? "Explicit regeneration replaces this user-owned seed after exact-content consent."
          : "Target schema adds an absent personalization seed and hands it off as user-owned content.",
      ...(currentDigest ? { currentDigest } : {}),
      desiredDigest: seed.digest,
    });
  }
  for (const destination of preservedSeeds) {
    actions.push({
      kind: "personalizationSeed",
      id: destination,
      action: "unchanged",
      target: `${params.workspace}:${destination}`,
      blocked: false,
      reason:
        "Existing personalization content is user-owned and is preserved without inspection or regeneration.",
      currentDigest: currentSeeds.get(destination)?.renderedDigest,
    });
  }
  for (const destination of releasedSeeds) {
    actions.push({
      kind: "personalizationSeed",
      id: destination,
      action: "release",
      target: `${params.workspace}:${destination}`,
      blocked: false,
      reason: "Target schema no longer declares this seed; the user-owned file remains in place.",
      currentDigest: currentSeeds.get(destination)?.renderedDigest,
    });
  }

  const materializedSeeds = new Map(
    (setup.materialization?.seeds ?? []).map((seed) => [seed.destination, seed] as const),
  );
  const targetAnswers = target.setup.inputs.flatMap((input) => {
    const materialized = setup.materialization?.answers.find((answer) => answer.id === input.id);
    if (materialized) {
      return [materialized];
    }
    const current = clearAnswers.has(input.id)
      ? undefined
      : params.currentSetup?.answers.find((answer) => answer.id === input.id);
    return current ? [current] : [];
  });
  const targetSeeds = target.personalization.seeds.flatMap((declaration) => {
    const materialized = materializedSeeds.get(declaration.destination);
    if (materialized) {
      return [
        {
          source: materialized.source,
          destination: materialized.destination,
          inputIds: materialized.inputIds,
          renderedDigest: materialized.digest,
          status: "pending" as const,
        },
      ];
    }
    const current = currentSeeds.get(declaration.destination);
    return current ? [current] : [];
  });
  const targetState =
    setup.materialization && targetSeeds.length === target.personalization.seeds.length
      ? {
          clawName: params.targetSource.name,
          clawVersion: params.targetSource.version,
          setupSchemaDigest: setup.plan.schemaDigest,
          answerDigest: digest(targetAnswers),
          answers: targetAnswers,
          seeds: targetSeeds,
        }
      : undefined;
  if (
    params.currentPending &&
    targetState &&
    (params.currentPending.setupSchemaDigest !== targetState.setupSchemaDigest ||
      params.currentPending.answerDigest !== targetState.answerDigest)
  ) {
    blockers.push(
      blocker(
        "setup_update_pending_conflict",
        "$.setup",
        "Pending personalization answers or schema do not match this update plan.",
      ),
    );
  }

  return {
    currentSchemaDigest: params.currentSetup?.setupSchemaDigest,
    targetSchemaDigest: setup.plan.schemaDigest,
    answerDigest: targetState?.answerDigest ?? setup.plan.answerDigest,
    createdSeeds,
    regeneratedSeeds,
    preservedSeeds,
    releasedSeeds,
    actions,
    blockers,
    materialization: setup.materialization,
    targetState,
  };
}
