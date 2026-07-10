import fsSync from "node:fs";
import fs from "node:fs/promises";
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
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { managedWorktrees, WorktreeSnapshotError } from "../../agents/worktrees/service.js";
import type { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandlers } from "./types.js";

type WorktreeService = Pick<
  ManagedWorktreeService,
  "create" | "gc" | "list" | "listRepositoryBranches" | "remove" | "restore"
>;

function invalidParams(respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"]): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid worktrees parameters"));
}

export function createWorktreesHandlers(service: WorktreeService): GatewayRequestHandlers {
  return {
    "worktrees.list": async ({ params, respond }) => {
      if (!validateWorktreesListParams(params)) {
        invalidParams(respond);
        return;
      }
      try {
        respond(true, { worktrees: await service.list() }, undefined);
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    "worktrees.create": async ({ params, respond }) => {
      if (!validateWorktreesCreateParams(params)) {
        invalidParams(respond);
        return;
      }
      try {
        respond(
          true,
          await service.create({
            repoRoot: params.repoRoot,
            name: params.name,
            baseRef: params.baseRef,
            ownerKind: "manual",
          }),
          undefined,
        );
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
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
      try {
        respond(true, await service.restore({ id: params.id }), undefined);
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    "worktrees.branches": async ({ params, respond, context, client }) => {
      if (!validateWorktreesBranchesParams(params)) {
        invalidParams(respond);
        return;
      }
      // Write scope may only enumerate configured agent workspaces; arbitrary
      // host paths stay behind the same admin bar as sessions.create cwd.
      const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
      if (!scopes.includes(ADMIN_SCOPE)) {
        const cfg = context.getRuntimeConfig();
        const requested = await fs.realpath(params.repoRoot).catch(() => null);
        const allowed =
          requested !== null &&
          listAgentIds(cfg).some((agentId) => {
            try {
              return fsSync.realpathSync(resolveAgentWorkspaceDir(cfg, agentId)) === requested;
            } catch {
              return false;
            }
          });
        if (!allowed) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `worktrees.branches outside configured agent workspaces requires gateway scope: ${ADMIN_SCOPE}`,
            ),
          );
          return;
        }
      }
      try {
        respond(true, await service.listRepositoryBranches(params.repoRoot), undefined);
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
    "worktrees.gc": async ({ params, respond }) => {
      if (!validateWorktreesGcParams(params)) {
        invalidParams(respond);
        return;
      }
      try {
        respond(true, await service.gc(), undefined);
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error)));
      }
    },
  };
}

export const worktreesHandlers = createWorktreesHandlers(managedWorktrees);
