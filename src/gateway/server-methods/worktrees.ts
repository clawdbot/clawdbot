import {
  ErrorCodes,
  errorShape,
  validateWorktreesBranchesParams,
  validateWorktreesCreateParams,
  validateWorktreesGcParams,
  validateWorktreesListParams,
  validateWorktreesRemoveParams,
  validateWorktreesRestoreParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { createManagedWorktreeOwnerProtection } from "../../agents/worktrees/owner-protection.js";
import {
  managedWorktrees,
  resolveWorktreeCleanupLimits,
  WorktreeSnapshotError,
} from "../../agents/worktrees/service.js";
import type { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { resolveRecordedProjectRoot } from "../../projects/project-registry.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveWorkspacePathContainment } from "./workspace-path-containment.js";

type WorktreeService = Pick<
  ManagedWorktreeService,
  "create" | "gc" | "list" | "listRepositoryBranches" | "remove" | "restore"
>;

function invalidParams(respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"]): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid worktrees parameters"));
}

async function resolveAuthorizedRepoRoot(
  method: string,
  repoRoot: string,
  opts: Parameters<GatewayRequestHandlers[string]>[0],
): Promise<string | undefined> {
  const scopes = Array.isArray(opts.client?.connect.scopes) ? opts.client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return repoRoot;
  }
  const containment = await resolveWorkspacePathContainment(
    repoRoot,
    opts.context.getRuntimeConfig(),
  );
  // A stored project row authorizes its canonical repo root for write-scoped clients.
  const authorizedRoot = containment?.path ?? (await resolveRecordedProjectRoot(repoRoot));
  if (authorizedRoot) {
    return authorizedRoot;
  }
  opts.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `${method} outside configured agent workspaces requires gateway scope: ${ADMIN_SCOPE}`,
    ),
  );
  return undefined;
}

export function createWorktreesHandlers(service: WorktreeService): GatewayRequestHandlers {
  return {
    "worktrees.list": async ({ params, respond }) => {
      if (!validateWorktreesListParams(params)) {
        invalidParams(respond);
        return;
      }
      respond(true, { worktrees: await service.list() }, undefined);
    },
    "worktrees.create": async (opts) => {
      const { params, respond } = opts;
      if (!validateWorktreesCreateParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("worktrees.create", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const scopes = Array.isArray(opts.client?.connect.scopes) ? opts.client.connect.scopes : [];
      respond(
        true,
        await service.create({
          repoRoot,
          name: params.name,
          baseRef: params.baseRef,
          ownerKind: "manual",
          // Repository hooks and .openclaw/worktree-setup.sh execute repo code.
          runSetupScript: scopes.includes(ADMIN_SCOPE),
        }),
        undefined,
      );
    },
    "worktrees.remove": async ({ params, respond }) => {
      if (!validateWorktreesRemoveParams(params)) {
        invalidParams(respond);
        return;
      }
      try {
        const result = await service.remove({
          id: params.id,
          reason: "manual-delete",
          force: params.force,
        });
        respond(
          true,
          {
            removed: result.removed,
            ...(result.snapshotRef ? { snapshotRef: result.snapshotRef } : {}),
            ...(result.snapshotError ? { snapshotError: result.snapshotError } : {}),
          },
          undefined,
        );
      } catch (error) {
        // Snapshot failures are a structured outcome: clients decide whether
        // to retry with force instead of sniffing error strings.
        if (error instanceof WorktreeSnapshotError) {
          respond(true, { removed: false, snapshotError: error.snapshotError }, undefined);
          return;
        }
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    "worktrees.restore": async ({ params, respond }) => {
      if (!validateWorktreesRestoreParams(params)) {
        invalidParams(respond);
        return;
      }
      respond(true, await service.restore({ id: params.id }), undefined);
    },
    "worktrees.branches": async (opts) => {
      const { params, respond } = opts;
      if (!validateWorktreesBranchesParams(params)) {
        invalidParams(respond);
        return;
      }
      const repoRoot = await resolveAuthorizedRepoRoot("worktrees.branches", params.repoRoot, opts);
      if (!repoRoot) {
        return;
      }
      const result = params.includeRepositoryStatus
        ? await service.listRepositoryBranches(repoRoot, {
            includeRepositoryStatus: true,
          })
        : await service.listRepositoryBranches(repoRoot);
      respond(true, result, undefined);
    },
    "worktrees.gc": async ({ params, respond, context }) => {
      if (!validateWorktreesGcParams(params)) {
        invalidParams(respond);
        return;
      }
      const cfg = context.getRuntimeConfig();
      const limits = resolveWorktreeCleanupLimits();
      respond(
        true,
        await service.gc({
          limits,
          shouldProtectOwner: createManagedWorktreeOwnerProtection(cfg),
        }),
        undefined,
      );
    },
  };
}

export const worktreesHandlers = createWorktreesHandlers(managedWorktrees);
