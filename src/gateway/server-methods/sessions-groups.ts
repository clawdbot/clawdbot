// Session group catalog mutations.
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateSessionsGroupsDefaultsParams,
  validateSessionsGroupsDeleteParams,
  validateSessionsGroupsListParams,
  validateSessionsGroupsPutParams,
  validateSessionsGroupsRenameParams,
  validateSessionsGroupsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { filterMutableSessionGroupRecords } from "../session-group-defaults-access.js";
import {
  deleteSessionGroup,
  listSessionGroupDefaults,
  listSidebarSectionOrder,
  listSessionGroups,
  putSessionGroups,
  renameSessionGroup,
  SessionGroupNotEmptyError,
  SessionGroupNotFoundError,
  updateSessionGroupDefaults,
} from "../session-groups.js";
import { resolveSessionGroupMutationTargetsByName } from "../session-sharing-target-input.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
import {
  isWorkspacePathContainmentCurrent,
  resolveWorkspacePathContainment,
} from "./workspace-path-containment.js";

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
  "sessions.groups.defaults": async ({ params, respond, client, context }) => {
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
    const defaults = filterMutableSessionGroupRecords({
      cfg: context.getRuntimeConfig(),
      client,
      records: listSessionGroupDefaults(),
    });
    respond(true, { defaults }, undefined);
  },
  "sessions.groups.put": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateSessionsGroupsPutParams, "sessions.groups.put", respond)
    ) {
      return;
    }
    try {
      const groups = putSessionGroups({
        cfg: context.getRuntimeConfig(),
        names: params.names,
        sectionOrder: params.sectionOrder,
      });
      respond(true, { ok: true, groups, sectionOrder: listSidebarSectionOrder() }, undefined);
      // Catalog-only changes still need to reach other open clients.
      emitSessionsChanged(context, { reason: "groups" });
    } catch (error) {
      if (error instanceof SessionGroupNotEmptyError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
    }
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
  "sessions.groups.update": async ({
    params,
    respond,
    context,
    client,
    sessionMutationAuthorization,
  }) => {
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
    const name = normalizeOptionalString(params.name);
    if (!name) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session group name must not be empty"),
      );
      return;
    }
    let cwd = params.cwd;
    const clientScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    if (cwd && !clientScopes.includes(ADMIN_SCOPE)) {
      const containment = await resolveWorkspacePathContainment(cwd, context.getRuntimeConfig());
      if (
        !containment ||
        !isWorkspacePathContainmentCurrent(containment, context.getRuntimeConfig())
      ) {
        respond(
          false,
          undefined,
          missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
        );
        return;
      }
      cwd = containment.path;
    }
    sessionMutationAuthorization?.assertCurrent();
    if (sessionMutationAuthorization) {
      const currentTargets =
        resolveSessionGroupMutationTargetsByName(context.getRuntimeConfig()).get(name) ?? [];
      for (const target of currentTargets) {
        sessionMutationAuthorization.assertTargetCurrent(target);
      }
    }
    const defaults = updateSessionGroupDefaults(name, {
      cwd,
      worktree: params.worktree,
    });
    if (!defaults) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown session group: ${name}`),
      );
      return;
    }
    respond(
      true,
      {
        ok: true,
        defaults: filterMutableSessionGroupRecords({
          cfg: context.getRuntimeConfig(),
          client,
          records: defaults,
        }),
      },
      undefined,
    );
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
