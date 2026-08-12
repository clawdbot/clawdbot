import {
  getPreparedRuntimeAuthMaterializations,
  registerRuntimeAuthMaterializationMutationListener,
  type RuntimeAuthMaterialization,
} from "./auth-profiles/runtime-materializations.js";
import { setPreparedModelRuntimeAuthMaterializations } from "./prepared-model-runtime-auth.js";
import {
  normalizeOptionalDir,
  type PreparedModelRuntimeOwner,
} from "./prepared-model-runtime.owner.js";

type MaterializationMutationEvent = {
  agentDir?: string;
  affectsInheritedStores: boolean;
};

export function registerPreparedRuntimeAuthMaterializationPublisher(
  owners: ReadonlyMap<string, PreparedModelRuntimeOwner>,
  notify: (event: { phase: "invalidated" | "published" }) => void,
): () => void {
  return registerRuntimeAuthMaterializationMutationListener((event) => {
    publishPreparedRuntimeAuthMaterializations({
      event,
      owners,
      onInvalidated: () => notify({ phase: "invalidated" }),
      onPublished: () => notify({ phase: "published" }),
    });
  });
}

function publishPreparedRuntimeAuthMaterializations(params: {
  event: MaterializationMutationEvent;
  owners: ReadonlyMap<string, PreparedModelRuntimeOwner>;
  onInvalidated: () => void;
  onPublished: () => void;
  read?: (agentDir?: string) => readonly RuntimeAuthMaterialization[];
}): void {
  const event = {
    ...params.event,
    agentDir: normalizeOptionalDir(params.event.agentDir),
  };
  const affectedOwners = [...params.owners.values()].flatMap((owner) => {
    const affected =
      event.affectsInheritedStores ||
      owner.input.agentDir === event.agentDir ||
      owner.input.inheritedAuthDir === event.agentDir;
    return affected && owner.snapshot && !owner.pending && !owner.needsRefresh
      ? [{ owner, snapshot: owner.snapshot }]
      : [];
  });
  if (affectedOwners.length === 0) {
    return;
  }
  params.onInvalidated();
  const read = params.read ?? getPreparedRuntimeAuthMaterializations;
  for (const { owner, snapshot } of affectedOwners) {
    // A successful route only changes this bounded secret-free fact set. Rebuilding the model
    // catalog here would pull plugin lifecycle work into the turn-completion boundary.
    setPreparedModelRuntimeAuthMaterializations(
      snapshot,
      Object.freeze([...read(owner.input.agentDir)]),
    );
  }
  params.onPublished();
}
