import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../packages/gateway-protocol/src/index.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getUserProfileRole } from "../state/user-profiles.js";
import { gatewayClientSessionCreator } from "./server-methods/gateway-client-identity.js";
import type { GatewayClient, GatewayOperatorRoleActor } from "./server-methods/shared-types.js";

const operatorRoleLog = createSubsystemLogger("gateway/operator-roles");
const MAX_OPERATOR_ROLE_ASSIGNMENTS = 1_024;
const operatorRoleAssignments = new Map<string, string | null>();
const reportedUnknownAssignments = new Set<string>();
const deniedOperatorRole: GatewayOperatorRoleDefinition = {
  sessions: { others: "none" },
  agents: [],
  scopes: [],
};

type GatewaySessionAgentAuthorization = {
  cfg: OpenClawConfig;
  agentId: string;
} & (
  | { actor: GatewayOperatorRoleActor; profileId?: never; client?: never }
  | { actor?: never; profileId: string | undefined; client?: never }
  | { actor?: never; profileId?: never; client: GatewayClient | null | undefined }
);

function readOperatorRoleAssignment(profileId: string): string | null {
  if (operatorRoleAssignments.has(profileId)) {
    return operatorRoleAssignments.get(profileId) ?? null;
  }
  const assignment = getUserProfileRole(profileId);
  if (operatorRoleAssignments.size >= MAX_OPERATOR_ROLE_ASSIGNMENTS) {
    const oldestProfileId = operatorRoleAssignments.keys().next().value;
    if (oldestProfileId !== undefined) {
      operatorRoleAssignments.delete(oldestProfileId);
      for (const reported of reportedUnknownAssignments) {
        if (reported.startsWith(`${oldestProfileId}:`)) {
          reportedUnknownAssignments.delete(reported);
        }
      }
    }
  }
  operatorRoleAssignments.set(profileId, assignment);
  return assignment;
}

/** Drops a changed assignment so subsequent authorization reads the durable owner. */
export function invalidateOperatorRolePolicy(profileId: string): void {
  operatorRoleAssignments.delete(profileId);
  for (const reported of reportedUnknownAssignments) {
    if (reported.startsWith(`${profileId}:`)) {
      reportedUnknownAssignments.delete(reported);
    }
  }
}

/** An enabled role boundary denies missing identity and unresolvable assignments. */
export function resolveOperatorRolePolicyForProfile(
  profileId: string | undefined,
  cfg: OpenClawConfig,
): GatewayOperatorRoleDefinition | undefined {
  const roles = cfg.gateway?.roles;
  if (!roles) {
    return undefined;
  }
  if (!profileId) {
    return deniedOperatorRole;
  }
  const assignedRole = readOperatorRoleAssignment(profileId);
  if (assignedRole && Object.hasOwn(roles.definitions, assignedRole)) {
    return roles.definitions[assignedRole];
  }
  if (assignedRole) {
    const reportKey = `${profileId}:${assignedRole}`;
    if (!reportedUnknownAssignments.has(reportKey)) {
      reportedUnknownAssignments.add(reportKey);
      operatorRoleLog.warn(
        `User profile ${profileId} references unknown Gateway role "${assignedRole}"; ${
          roles.default ? `applying default role "${roles.default}"` : "denying access"
        }. Update gateway.roles.definitions or clear the assignment with users.setRole.`,
      );
    }
  }
  return (roles.default ? roles.definitions[roles.default] : undefined) ?? deniedOperatorRole;
}

/** Resolves the current named policy from the connection's verified profile identity. */
export function resolveGatewayOperatorRoleActor(
  client: GatewayClient | null | undefined,
): GatewayOperatorRoleActor | undefined {
  const actor = client?.internal?.operatorRoleActor;
  if (actor) {
    return actor;
  }
  const profileId = gatewayClientSessionCreator(client ?? null)?.id;
  return profileId ? { kind: "operator", profileId } : undefined;
}

/** Resolves the current named policy from an authoritative operator or system actor. */
export function resolveOperatorRolePolicy(
  client: GatewayClient | null,
  cfg: OpenClawConfig,
): GatewayOperatorRoleDefinition | undefined {
  const actor = resolveGatewayOperatorRoleActor(client);
  if (actor?.kind === "system") {
    return undefined;
  }
  return resolveOperatorRolePolicyForProfile(actor?.profileId, cfg);
}

export function operatorSessionCap(client: GatewayClient | null, cfg: OpenClawConfig) {
  return resolveOperatorRolePolicy(client, cfg)?.sessions.others;
}

export function hasOperatorBoundary(client: GatewayClient | null, cfg: OpenClawConfig): boolean {
  return operatorSessionCap(client, cfg) !== undefined;
}

/** Enforces the owning agent ceiling for session creation and run-start targets. */
export function authorizeGatewaySessionCreation(
  params: GatewaySessionAgentAuthorization,
): ErrorShape | undefined {
  const actor =
    params.actor ??
    ("client" in params ? resolveGatewayOperatorRoleActor(params.client) : undefined);
  if (actor?.kind === "system") {
    return undefined;
  }
  const profileId = actor?.profileId ?? params.profileId;
  const role = resolveOperatorRolePolicyForProfile(profileId, params.cfg);
  if (!role || role.agents === "*" || role.agents.includes(params.agentId)) {
    return undefined;
  }
  return errorShape(
    ErrorCodes.FORBIDDEN,
    `Your operator role cannot create sessions for agent "${params.agentId}"; choose an allowed agent or ask a gateway administrator to update your role.`,
  );
}
