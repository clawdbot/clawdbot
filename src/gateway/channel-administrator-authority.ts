import { randomBytes } from "node:crypto";
import {
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import type { GatewayClient } from "./server-methods/types.js";

/** Opaque host-owned authority; its public fields cannot recreate the capability. */
export type ChannelAdministratorAuthority = Readonly<{ runId: string }>;
export type ChannelAdministratorGrant = Readonly<{ runId: string; token: string }>;

type AuthorityState = {
  signal: AbortSignal;
  assertPolicyCurrent: () => void;
  tokens: Set<string>;
  boundAuthority?: AgentRunDelegatedAuthority;
};
type GrantState = {
  capability: ChannelAdministratorAuthority;
  authority: AgentRunDelegatedAuthority;
  method: string;
  expiresAtMs: number;
  signal?: AbortSignal;
  revoke: () => void;
};
const authorities = new WeakMap<ChannelAdministratorAuthority, AuthorityState>();
const grants = new Map<string, GrantState>();
const requestAuthorities = new WeakMap<object, () => void>();

function denied(): Error {
  return new Error(
    "Trusted channel administrator authority is missing or no longer active. Retry from a fresh authorized message.",
  );
}

/** Only the fresh, authenticated ingress admission calls this constructor. */
export function createChannelAdministratorAuthority(
  runId: string,
  signal: AbortSignal,
  assertPolicyCurrent: () => void,
): ChannelAdministratorAuthority {
  signal.throwIfAborted();
  assertPolicyCurrent();
  const capability = Object.freeze({ runId });
  const state: AuthorityState = { signal, assertPolicyCurrent, tokens: new Set<string>() };
  authorities.set(capability, state);
  signal.addEventListener(
    "abort",
    () => {
      for (const token of state.tokens) {
        grants.get(token)?.revoke();
      }
      authorities.delete(capability);
    },
    { once: true },
  );
  return capability;
}

export function assertChannelAdministratorAuthority(
  capability: ChannelAdministratorAuthority,
  authority: AgentRunDelegatedAuthority,
): void {
  const state = authorities.get(capability);
  if (
    !state ||
    state.signal.aborted ||
    capability.runId !== authority.operationalRunInstance.runId ||
    !validateAgentRunDelegatedAuthority(authority)
  ) {
    throw denied();
  }
  state.assertPolicyCurrent();
  const bound = state.boundAuthority;
  if (
    bound &&
    (bound.operationalRunInstance.instanceId !== authority.operationalRunInstance.instanceId ||
      bound.operationalRunInstance.runId !== authority.operationalRunInstance.runId ||
      bound.lifecycleGeneration !== authority.lifecycleGeneration ||
      bound.claimId !== authority.claimId)
  ) {
    throw denied();
  }
  // Fresh ingress predates execution admission. The first tool binding seals the
  // capability to that exact instance/claim, not merely the caller-chosen run id.
  state.boundAuthority ??= Object.freeze({
    ...authority,
    operationalRunInstance: Object.freeze({ ...authority.operationalRunInstance }),
  });
}

/** One request, method, run instance, and execution claim; never a reusable admin bearer. */
export function mintChannelAdministratorGrant(
  capability: ChannelAdministratorAuthority,
  authority: AgentRunDelegatedAuthority,
  method: string,
  signal?: AbortSignal,
): ChannelAdministratorGrant {
  assertChannelAdministratorAuthority(capability, authority);
  signal?.throwIfAborted();
  const token = randomBytes(32).toString("base64url");
  const state = authorities.get(capability)!;
  const revoke = () => {
    grants.delete(token);
    state.tokens.delete(token);
    signal?.removeEventListener("abort", revoke);
  };
  grants.set(token, {
    capability,
    authority,
    method,
    expiresAtMs: Date.now() + 60_000,
    signal,
    revoke,
  });
  state.tokens.add(token);
  signal?.addEventListener("abort", revoke, { once: true });
  return Object.freeze({ runId: capability.runId, token });
}

/** Redeem at the router, retaining live policy and execution fences through commit. */
export function redeemChannelAdministratorGrant(
  grant: ChannelAdministratorGrant,
  identity: AgentRuntimeIdentity,
  method: string,
): () => void {
  const entry = grants.get(grant.token);
  const actual = identity.delegatedAuthority;
  if (
    !entry ||
    entry.method !== method ||
    grant.runId !== entry.capability.runId ||
    entry.authority.operationalRunInstance.runId !== identity.operationalRunInstance.runId ||
    entry.authority.operationalRunInstance.instanceId !==
      identity.operationalRunInstance.instanceId ||
    entry.authority.lifecycleGeneration !== actual.lifecycleGeneration ||
    entry.authority.claimId !== actual.claimId
  ) {
    throw denied();
  }
  entry.revoke();
  const assertActive = () => {
    if (Date.now() >= entry.expiresAtMs || entry.signal?.aborted) {
      throw denied();
    }
    assertChannelAdministratorAuthority(entry.capability, entry.authority);
  };
  assertActive();
  return assertActive;
}

/** Request-local client projection, not a connection-wide or child-session privilege. */
export function admitChannelAdministratorRequest(
  client: GatewayClient | null | undefined,
  method: string,
): { client: GatewayClient; assertActive: () => void } | undefined {
  const identity = client?.internal?.agentRuntimeIdentity;
  if (!identity?.channelAdministratorGrant) {
    return undefined;
  }
  if (!client || client.connect.role !== "operator") {
    throw denied();
  }
  const assertActive = redeemChannelAdministratorGrant(
    identity.channelAdministratorGrant,
    identity,
    method,
  );
  const admittedClient = {
    ...client,
    connect: {
      ...client.connect,
      scopes: [...new Set([...(client.connect.scopes ?? []), "operator.admin"])],
    },
  };
  requestAuthorities.set(admittedClient, assertActive);
  return { client: admittedClient, assertActive };
}

/** An admin scope or source label alone never grants cross-session scheduler access. */
export function getChannelAdministratorRequestAuthority(
  client: GatewayClient | null | undefined,
): (() => void) | undefined {
  const authority = client ? requestAuthorities.get(client) : undefined;
  authority?.();
  return authority;
}
