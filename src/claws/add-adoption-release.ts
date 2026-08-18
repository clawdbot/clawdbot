import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../agents/workspace-bootstrap-read.js";
// Adoption owns an operator-configured agent only once the final config compare-and-swap wins.
// A record kept after that swap loses claims an agent Claw never took: resume rejects the changed
// digest, remove refuses a modified agent, and a remove that did run would delete operator config
// Claw never adopted. Roll back exactly what this attempt wrote, then drop the claim.
import { clearWorkspaceBootstrapSeedMarker } from "../agents/workspace-bootstrap-seed-marker.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import type { ClawAddApplyOptions } from "./add-contract.js";
import {
  releaseClawRemoveRows,
  removeClawWorkspaceFile,
  type RemovedWorkspaceFile,
} from "./lifecycle-delete-support.js";
import { applyClawPackageRemovals, planClawPackageRemovals } from "./package-remove.js";
import type { PersistedClawInstall, PersistedClawPackageRef } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";
import type { PersistedClawWorkspaceFile } from "./workspace.js";

/**
 * Releases an adoption record whose config commit never landed. Returns the paths that survived
 * rollback; while any remain, Claw still owns real state and keeps the record to clean it later.
 */
export async function releaseUnclaimedClawAdoption(params: {
  plan: ClawAddPlan;
  install: PersistedClawInstall;
  workspaceFiles: PersistedClawWorkspaceFile[];
  packages: PersistedClawPackageRef[];
  bootstrapSeeded: boolean;
  options: ClawAddApplyOptions;
}): Promise<{ released: boolean; retained: string[] }> {
  // A declared file that already existed with identical content was adopted, not written, so the
  // attempt owns its row but never owned its bytes. Dropping the row is the whole rollback.
  const adoptedPaths = new Set(
    params.plan.actions
      .filter((action) => action.kind === "workspaceFile" && action.action === "adopt")
      .map((action) => action.id),
  );
  const removals: RemovedWorkspaceFile[] = [];
  for (const file of params.workspaceFiles) {
    removals.push(
      adoptedPaths.has(file.path)
        ? { path: file.path, action: "missing" }
        : await removeClawWorkspaceFile({ ...file, state: "unchanged" }),
    );
  }
  let bootstrapRemoval: RemovedWorkspaceFile | undefined;
  if (params.install.bootstrap) {
    bootstrapRemoval = await removeClawWorkspaceFile(
      {
        workspace: params.install.workspace,
        path: DEFAULT_BOOTSTRAP_FILENAME,
        contentDigest: params.install.bootstrap.contentDigest,
        state: "unchanged",
      },
      MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
    );
    removals.push(bootstrapRemoval);
  }
  // The seed marker and the file are one fact. Deleting the file while the marker stands makes the
  // next seed read "already seeded, file gone" as consumed and write nothing at all.
  if (params.bootstrapSeeded && bootstrapRemoval?.action === "deleted") {
    clearWorkspaceBootstrapSeedMarker(
      params.install.workspace,
      params.options.nowMs ?? Date.now(),
      params.options,
    );
  }
  const retained = removals
    .filter((removal) => removal.action === "retainedModified" || removal.action === "error")
    .map((removal) => removal.path);
  // Stop before the packages when a file survived: half-uninstalling what the retained record
  // still claims would leave ownership describing state that is already gone.
  if (retained.length > 0) {
    releaseClawRemoveRows(params.install.agentId, removals, false, params.options, true);
    return { released: false, retained };
  }
  if (params.packages.length > 0) {
    const decisions = await planClawPackageRemovals(
      params.install,
      params.packages,
      params.options,
    );
    const results = await applyClawPackageRemovals(decisions, params.options);
    // A referenced package another Claw still owns stays installed; only a failed uninstall
    // leaves state this attempt cannot account for.
    retained.push(
      ...results
        .filter((result) => result.action === "error")
        .map((result) => `${result.kind}:${result.ref}`),
    );
  }
  if (retained.length > 0) {
    releaseClawRemoveRows(params.install.agentId, removals, false, params.options, true);
    return { released: false, retained };
  }
  // Adopted state was never Claw-created, so its durable agent-database registration is not this
  // attempt's to unregister.
  releaseClawRemoveRows(params.install.agentId, removals, true, params.options, true);
  return { released: true, retained: [] };
}
