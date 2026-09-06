import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { z } from "zod";
import { NODE_WORKER_WORKSPACE_PREPARE_COMMAND } from "../../infra/node-commands.js";
import type { WorkerProfile } from "../../plugins/types.js";
import type { WorkerProjectSnapshot } from "./workspace-git-base.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Artifacts = z
  .object({
    nodeBootstrapSha256: Digest,
    enabledPluginIds: z.array(z.string().min(1).max(256)).max(256),
    workerBundleHash: Digest,
    workerArchiveSha256: Digest,
    openclawVersion: z.string().min(1).max(128),
    protocolFeatures: z.array(z.string().min(1).max(128)).max(64),
  })
  .strict();
const Target = z
  .object({
    machineClass: z.string().min(1).max(256),
    platform: z.string().min(1).max(64),
    arch: z.string().min(1).max(64),
  })
  .strict();
const Preparation = z
  .object({
    key: Digest,
    cacheKey: Digest,
    contractVersion: z.literal(1),
    setupRecipe: z
      .string()
      .regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u)
      .optional(),
    target: Target,
    artifacts: Artifacts,
  })
  .strict();

export type WorkerPreparationArtifacts = z.infer<typeof Artifacts>;
export type WorkerProjectPreparationIdentity = z.infer<typeof Preparation>;
export type WorkerProviderPreparedIntent = {
  providerId: string;
  profileSnapshot: WorkerProfile;
  preparationKey?: string;
};

/** Immutable artifact facts are separate from the reserve's demand/expiry/consumption tuple. */
export function readWorkerProjectPreparation(
  project: unknown,
): WorkerProjectPreparationIdentity | undefined {
  if (!isRecord(project) || project.preparation === undefined) {
    return undefined;
  }
  const parsed = Preparation.safeParse(project.preparation);
  if (!parsed.success) {
    throw new Error("Worker project preparation identity is invalid");
  }
  return parsed.data;
}

export function createWorkerProjectPreparationIdentity(params: {
  namespace: string;
  providerId: string;
  profileId: string;
  profileSnapshot: WorkerProfile;
  project: WorkerProjectSnapshot;
  target: WorkerProjectPreparationIdentity["target"];
  artifacts: WorkerPreparationArtifacts;
  setupRecipe?: string;
}): WorkerProjectPreparationIdentity {
  const artifacts = Artifacts.parse(params.artifacts);
  artifacts.enabledPluginIds = [...new Set(artifacts.enabledPluginIds)].toSorted();
  artifacts.protocolFeatures = [...new Set(artifacts.protocolFeatures)].toSorted();
  const facts = {
    contractVersion: 1 as const,
    ...(params.setupRecipe ? { setupRecipe: params.setupRecipe } : {}),
    target: Target.parse(params.target),
    artifacts,
  };
  // Source root is transport location only: linked worktrees share Git identity.
  // The explicit contract version also invalidates Gateway-owned setup semantics.
  const compatibility = {
    ...facts,
    namespace: params.namespace,
    providerId: params.providerId,
    profileId: params.profileId,
    profile: {
      ...params.profileSnapshot,
      machineClass: facts.target.machineClass,
      executionMode: params.profileSnapshot.executionMode ?? "worker-turn",
    },
    project: { key: params.project.key },
    workspaceProtocol: NODE_WORKER_WORKSPACE_PREPARE_COMMAND,
  };
  const digest = (value: unknown) =>
    createHash("sha256").update(stableStringify(value)).digest("hex");
  // An older checkout can accelerate preparation, but only the exact commit may
  // advertise readiness. Keep its physical cache identity separate from that claim.
  return {
    key: digest({
      ...compatibility,
      project: { ...compatibility.project, baseCommit: params.project.baseCommit },
    }),
    cacheKey: digest(compatibility),
    ...facts,
  };
}
