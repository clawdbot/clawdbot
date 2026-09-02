import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { resolvePersonalGitHubOwner } from "../../state/user-github-connections.js";
import type { PersonalGitHubAction } from "../github-personal-oauth.js";
import {
  resolveOperatorRolePolicy,
  resolveOperatorRolePolicyForProfile,
} from "../operator-role-policy.js";
import {
  createSessionListEntryFilter,
  resolveSessionMutationAuthorization,
} from "../session-sharing.js";
import {
  type GatewaySessionStoreDiscoveryCache,
  loadGatewaySessionEntryReadOnly,
} from "../session-utils.js";
import { isGatewayClientProfilePending } from "./gateway-client-identity.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

type Request = Pick<GatewayRequestHandlerOptions, "client" | "context" | "signal">;

function isSyntheticCaller(client: GatewayClient | null): boolean {
  return Boolean(
    client?.internal?.syntheticClient ||
    client?.internal?.agentToolCaller ||
    client?.internal?.agentRuntimeIdentity ||
    getGatewayToolCallerIdentity(),
  );
}

/** Intersect the live role ceiling with the socket grant, preserving scope implications. */
function currentGitHubClient(
  options: Request,
  scope: "operator.read" | "operator.write",
  owner?: string,
) {
  const { client, context } = options;
  if (
    options.signal?.aborted ||
    (client?.connId &&
      !isSyntheticCaller(client) &&
      !context.getClientConnIds?.((current) => current === client).has(client.connId))
  ) {
    throw new Error("GitHub request connection is no longer current; reconnect and try again.");
  }
  if (!client) {
    return null;
  }
  if (isGatewayClientProfilePending(client)) {
    throw new Error("Authenticated profile verification is unavailable; retry the request.");
  }
  const cfg = context.getRuntimeConfig();
  const policy = owner
    ? resolveOperatorRolePolicyForProfile(owner, cfg)
    : resolveOperatorRolePolicy(client, cfg);
  const granted = client.connect.scopes ?? [];
  const scopes = policy
    ? [...new Set([...granted, ...policy.scopes])].filter((candidate) =>
        [granted, policy.scopes].every((allowedScopes) =>
          roleScopesAllow({
            role: "operator",
            requestedScopes: [candidate],
            allowedScopes,
          }),
        ),
      )
    : granted;
  if (
    client.connect.role !== "operator" ||
    !roleScopesAllow({
      role: "operator",
      requestedScopes: [scope],
      allowedScopes: scopes,
    })
  ) {
    throw new Error(`GitHub requires current ${scope} permission.`);
  }
  return {
    ...client,
    connect: { ...client.connect, scopes },
    ...(owner && client.authenticatedUserProfile
      ? { authenticatedUserProfile: { ...client.authenticatedUserProfile, profileId: owner } }
      : {}),
  };
}

type PersonalEligibility =
  | { kind: "eligible"; action: PersonalGitHubAction }
  | { kind: "absent" | "ineligible" };

/** Shared reads do not require a person; absence never substitutes for failed authentication. */
export function prepareGitHubPublicationOptionsRead(options: Request, sessionKey: string) {
  // Store discovery is stable within this request; session rows remain live reads.
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  const resolveEligibility = (): PersonalEligibility => {
    currentGitHubClient(options, "operator.read");
    const client = options.client;
    if (!client?.connId || isSyntheticCaller(client) || client.internal?.operatorRoleActor) {
      return { kind: "ineligible" };
    }
    if (!client.authenticatedUserProfile) {
      return { kind: "absent" };
    }
    return { kind: "eligible", action: preparePersonalGitHubAction(options) };
  };
  const personal = resolveEligibility();
  const currentClient = () => {
    const current = resolveEligibility();
    if (
      current.kind !== personal.kind ||
      (current.kind === "eligible" &&
        personal.kind === "eligible" &&
        current.action.owner !== personal.action.owner)
    ) {
      throw new Error("GitHub profile changed; retry publication options.");
    }
    return currentGitHubClient(
      options,
      "operator.read",
      current.kind === "eligible" ? current.action.owner : undefined,
    );
  };
  const readSession = (key: string, agentId?: string) => {
    const loaded = loadGatewaySessionEntryReadOnly(key, { agentId, targetDiscoveryCache });
    const filter = createSessionListEntryFilter({
      cfg: options.context.getRuntimeConfig(),
      client: currentClient(),
    });
    return loaded.entry && filter?.(loaded.canonicalKey, loaded.entry) !== false
      ? {
          sessionId: loaded.entry.sessionId,
          sessionKey: loaded.canonicalKey,
          agentId: loaded.agentId,
        }
      : null;
  };
  const session = readSession(sessionKey);
  if (!session) {
    throw new Error("GitHub publication session was not found.");
  }
  return {
    personal,
    session,
    currentSession: () => {
      const current = readSession(session.sessionKey, session.agentId);
      if (!current || current.sessionId !== session.sessionId) {
        throw new Error("GitHub publication session access changed; select the session again.");
      }
      return session;
    },
  };
}

/** Authority stays in this direct connection closure; a profile or request id alone grants nothing. */
export function preparePersonalGitHubAction(
  options: Request,
  scope: "operator.read" | "operator.write" = "operator.read",
): PersonalGitHubAction {
  const { client, context } = options;
  const resolveOwner = () => {
    if (
      !client?.connId ||
      client.connect?.role !== "operator" ||
      isSyntheticCaller(client) ||
      client.internal?.operatorRoleActor ||
      options.signal?.aborted ||
      !context.getClientConnIds?.((current) => current === client).has(client.connId)
    ) {
      throw new Error("My GitHub requires a current authenticated human Gateway connection.");
    }
    const profile = client.authenticatedUserProfile?.profileId;
    const owner = profile ? resolvePersonalGitHubOwner(profile) : undefined;
    if (!owner) {
      throw new Error("My GitHub requires a verified durable user profile; sign in and try again.");
    }
    currentGitHubClient(options, scope, owner);
    return owner;
  };
  const owner = resolveOwner();
  return {
    owner,
    assertCurrent: () => {
      if (resolveOwner() !== owner) {
        throw new Error("My GitHub owner changed; retry from your current profile.");
      }
    },
  };
}

export function preparePersonalGitHubSessionAction(
  options: Request,
  sessionKey: string,
): PersonalGitHubAction & { sessionId: string; sessionKey: string; agentId: string } {
  const action = preparePersonalGitHubAction(options, "operator.write");
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  const initial = loadGatewaySessionEntryReadOnly(sessionKey, { targetDiscoveryCache });
  if (!initial.entry?.sessionId) {
    throw new Error("GitHub publication session was not found.");
  }
  const sessionId = initial.entry.sessionId;
  const assertCurrent = () => {
    action.assertCurrent();
    const current = loadGatewaySessionEntryReadOnly(initial.canonicalKey, {
      agentId: initial.agentId,
      targetDiscoveryCache,
    });
    if (
      current.entry?.sessionId !== sessionId ||
      current.entry.archivedAt !== undefined ||
      current.canonicalKey !== initial.canonicalKey
    ) {
      throw new Error(
        "GitHub publication session changed; select the current session and try again.",
      );
    }
    // This is a session mutation, not a run start. Preserve current admin rights without
    // retaining an admin grant that the person's live role no longer permits.
    const { error } = resolveSessionMutationAuthorization({
      client: currentGitHubClient(options, "operator.write", action.owner),
      method: "sessions.github.publish",
      requestParams: { sessionKey: initial.canonicalKey, agentId: initial.agentId },
      context: options.context,
    });
    if (error) {
      throw new Error(error.message);
    }
  };
  assertCurrent();
  return {
    ...action,
    assertCurrent,
    sessionId,
    sessionKey: initial.canonicalKey,
    agentId: initial.agentId,
  };
}
