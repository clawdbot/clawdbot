import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { cloneCronRuntimeAuthority, type CronRuntimeAuthority } from "../cron/runtime-authority.js";
import {
  normalizeCronScheduledToolCallerOrigin,
  type CronScheduledToolCallerOrigin,
} from "../cron/scheduled-tool-policy.js";
import {
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import type { AgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import type { CronCreatorAuthorityGrant } from "./cron-creator-authority-grant.types.js";

export const CRON_MANAGEMENT_METHODS = [
  "cron.list",
  "cron.get",
  "cron.update",
  "cron.run",
  "cron.remove",
] as const;
type CronManagementBinding = { method: string; authority: AgentRunDelegatedAuthority };
const activeManagement = new AsyncLocalStorage<{
  identity: AgentRuntimeIdentity;
  assertActive: () => void;
}>();

export type CronCreatorAuthorityRunScope = {
  readonly runId: string;
  readonly callerOrigin: CronScheduledToolCallerOrigin;
  readonly signal: AbortSignal;
  readonly grantTokens: Set<string>;
  readonly controlUiAdmin?: true;
  active: boolean;
  abort: () => void;
};

type CronCreatorAuthorityGrantEntry = {
  scope: CronCreatorAuthorityRunScope;
  runtimeAuthority?: CronRuntimeAuthority;
  operationSignal?: AbortSignal;
  onOperationAbort?: () => void;
  management?: CronManagementBinding & { expiresAtMs: number };
};

const grantsByToken = new Map<string, CronCreatorAuthorityGrantEntry>();

function expiredAuthorityError(): Error & { status: number } {
  return Object.assign(
    new TypeError(
      "Configured MCP cron authority is no longer active for this run. Retry the automation mutation from the active local operator turn.",
    ),
    { name: "CronCreatorAuthorityExpiredError", status: 403 },
  );
}

export function createCronCreatorAuthorityRunScope(
  runId: string,
  callerOrigin: CronScheduledToolCallerOrigin = { kind: "unknown" },
  controlUiAdmin?: true,
): CronCreatorAuthorityRunScope {
  const abortController = new AbortController();
  return {
    runId,
    callerOrigin: normalizeCronScheduledToolCallerOrigin(callerOrigin),
    signal: abortController.signal,
    grantTokens: new Set(),
    ...(controlUiAdmin ? { controlUiAdmin } : {}),
    active: true,
    abort: () => abortController.abort(expiredAuthorityError()),
  };
}

export function mintCronCreatorAuthorityGrant(
  scope: CronCreatorAuthorityRunScope,
  operationSignal?: AbortSignal,
  runtimeAuthority?: CronRuntimeAuthority,
  management?: CronManagementBinding,
): CronCreatorAuthorityGrant {
  if (!scope.active || scope.signal.aborted || operationSignal?.aborted) {
    throw management ? expiredManagementError() : expiredAuthorityError();
  }
  if (!management && scope.controlUiAdmin && scope.callerOrigin.kind === "unknown") {
    throw new TypeError(
      "Automation creation is not granted to this turn. Use the Automations page to create an automation.",
    );
  }
  if (
    management &&
    (!scope.controlUiAdmin ||
      !CRON_MANAGEMENT_METHODS.some((method) => method === management.method) ||
      management.authority.operationalRunInstance.runId !== scope.runId ||
      !validateAgentRunDelegatedAuthority(management.authority))
  ) {
    throw expiredManagementError();
  }
  const token = randomBytes(32).toString("base64url");
  const normalizedRuntimeAuthority = runtimeAuthority
    ? cloneCronRuntimeAuthority(runtimeAuthority)
    : undefined;
  if (runtimeAuthority && !normalizedRuntimeAuthority) {
    throw new TypeError("cron creator runtime authority is invalid");
  }
  const entry: CronCreatorAuthorityGrantEntry = {
    scope,
    operationSignal,
    ...(normalizedRuntimeAuthority ? { runtimeAuthority: normalizedRuntimeAuthority } : {}),
    ...(management ? { management: { ...management, expiresAtMs: Date.now() + 60_000 } } : {}),
  };
  if (operationSignal) {
    entry.onOperationAbort = () => revokeCronCreatorAuthorityGrant(token);
  }
  grantsByToken.set(token, entry);
  scope.grantTokens.add(token);
  if (operationSignal && entry.onOperationAbort) {
    operationSignal.addEventListener("abort", entry.onOperationAbort, { once: true });
  }
  return Object.freeze({ runId: scope.runId, token });
}

function revokeCronCreatorAuthorityGrant(token: string): void {
  const entry = grantsByToken.get(token);
  if (!entry) {
    return;
  }
  grantsByToken.delete(token);
  entry.scope.grantTokens.delete(token);
  if (entry.operationSignal && entry.onOperationAbort) {
    entry.operationSignal.removeEventListener("abort", entry.onOperationAbort);
  }
}

export function revokeCronCreatorAuthorityRunScope(scope: CronCreatorAuthorityRunScope): void {
  if (!scope.active) {
    return;
  }
  scope.active = false;
  scope.abort();
  for (const token of scope.grantTokens) {
    revokeCronCreatorAuthorityGrant(token);
  }
}

/** Consumes one live exact-run grant synchronously at the cron commit boundary. */
export function consumeCronCreatorAuthorityGrant(
  grant: CronCreatorAuthorityGrant,
): CronRuntimeAuthority | undefined {
  const runId = grant.runId.trim();
  const token = grant.token.trim();
  const entry = token ? grantsByToken.get(token) : undefined;
  if (!entry) {
    throw expiredAuthorityError();
  }
  const scope = entry.scope;
  if (
    entry.management ||
    !scope.active ||
    scope.signal.aborted ||
    entry.operationSignal?.aborted ||
    scope.runId !== runId
  ) {
    if (!scope.active || scope.signal.aborted || entry.operationSignal?.aborted) {
      revokeCronCreatorAuthorityGrant(token);
    }
    throw expiredAuthorityError();
  }
  revokeCronCreatorAuthorityGrant(token);
  return entry.runtimeAuthority ? cloneCronRuntimeAuthority(entry.runtimeAuthority) : undefined;
}

function expiredManagementError(): TypeError {
  return new TypeError(
    "Automation admin grant is missing, expired, or already used. Retry from a fresh authenticated Control UI administrator turn, or use the Automations page.",
  );
}

/** Redeem once, retaining the exact operational owner through every await and commit. */
export async function withCronManagementGrant<T>(
  grant: CronCreatorAuthorityGrant,
  identity: AgentRuntimeIdentity,
  method: string,
  run: () => Promise<T>,
): Promise<T> {
  const entry = grantsByToken.get(grant.token);
  const management = entry?.management;
  const authority = identity.delegatedAuthority;
  if (
    !entry ||
    !management ||
    management.method !== method ||
    grant.runId !== entry.scope.runId ||
    management.authority.operationalRunInstance.instanceId !==
      identity.operationalRunInstance.instanceId ||
    management.authority.operationalRunInstance.runId !== identity.operationalRunInstance.runId ||
    management.authority.lifecycleGeneration !== authority.lifecycleGeneration ||
    management.authority.claimId !== authority.claimId
  ) {
    throw expiredManagementError();
  }
  revokeCronCreatorAuthorityGrant(grant.token);
  const assertActive = () => {
    if (
      !entry.scope.active ||
      entry.scope.signal.aborted ||
      entry.operationSignal?.aborted ||
      Date.now() >= management.expiresAtMs ||
      !validateAgentRunDelegatedAuthority(management.authority)
    ) {
      throw expiredManagementError();
    }
  };
  assertActive();
  // Queue acknowledgement precedes reservation. Its retained guard still
  // belongs to this exact live run, signal, and expiry after the RPC returns.
  return await activeManagement.run({ identity, assertActive }, run);
}

export function getCronManagementAuthority(
  identity: AgentRuntimeIdentity,
): (() => void) | undefined {
  const management = activeManagement.getStore();
  return management?.identity === identity ? management.assertActive : undefined;
}
