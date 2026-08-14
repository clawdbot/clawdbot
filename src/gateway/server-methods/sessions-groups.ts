// Session group catalog mutations.
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  validateSessionsGroupsDefaultsParams,
  validateSessionsGroupsDeleteParams,
  validateSessionsGroupsListParams,
  validateSessionsGroupsPutParams,
  validateSessionsGroupsRenameParams,
  validateSessionsGroupsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  deleteSessionGroup,
  listSessionGroupDefaults,
  listSidebarSectionOrder,
  listSessionGroups,
  putSessionGroups,
  renameSessionGroup,
  SessionGroupNotFoundError,
  updateSessionGroupDefaults,
} from "../session-groups.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionGroupHandlers: GatewayRequestHandlers = {
  "sessions.groups.list": async ({ params, respond }) => {
    if (
      !assertValidParams(params, validateSessionsGroupsListParams, "sessions.groups.list", respond)
    ) {
      return;
    }
    respond(
      true,
      { groups: listSessionGroups(), sectionOrder: listSidebarSectionOrder() },
      undefined,
    );
  },
  "sessions.groups.defaults": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsGroupsDefaultsParams,
        "sessions.groups.defaults",
        respond,
      )
    ) {
      return;
    }
    respond(true, { defaults: listSessionGroupDefaults() }, undefined);
  },
  "sessions.groups.put": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateSessionsGroupsPutParams, "sessions.groups.put", respond)
    ) {
      return;
    }
    const groups = putSessionGroups(params.names, params.sectionOrder);
    respond(true, { ok: true, groups, sectionOrder: listSidebarSectionOrder() }, undefined);
    // Catalog-only changes still need to reach other open clients.
    emitSessionsChanged(context, { reason: "groups" });
  },
  "sessions.groups.rename": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsGroupsRenameParams,
        "sessions.groups.rename",
        respond,
      )
    ) {
      return;
    }
    try {
      const result = await renameSessionGroup({
        cfg: context.getRuntimeConfig(),
        name: params.name,
        to: params.to,
        assertCurrent: sessionMutationAuthorization?.assertCurrent,
        assertTargetCurrent: sessionMutationAuthorization?.assertTargetCurrent,
      });
      respond(true, { ok: true, ...result }, undefined);
      emitSessionsChanged(context, { reason: "groups" });
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      if (error instanceof SessionGroupNotFoundError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
  "sessions.groups.update": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsGroupsUpdateParams,
        "sessions.groups.update",
        respond,
      )
    ) {
      return;
    }
    if (params.cwd && !path.isAbsolute(params.cwd)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session group cwd must be absolute"),
      );
      return;
    }
    const defaults = updateSessionGroupDefaults(params.name, {
      cwd: params.cwd,
      worktree: params.worktree,
    });
    if (!defaults) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown session group: ${params.name}`),
      );
      return;
    }
    respond(true, { ok: true, defaults }, undefined);
    emitSessionsChanged(context, { reason: "groups" });
  },
  "sessions.groups.delete": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsGroupsDeleteParams,
        "sessions.groups.delete",
        respond,
      )
    ) {
      return;
    }
    try {
      const result = await deleteSessionGroup({
        cfg: context.getRuntimeConfig(),
        name: params.name,
        assertCurrent: sessionMutationAuthorization?.assertCurrent,
        assertTargetCurrent: sessionMutationAuthorization?.assertTargetCurrent,
      });
      respond(true, { ok: true, ...result }, undefined);
      emitSessionsChanged(context, { reason: "groups" });
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
  },
};
