/** Guards SSH sandbox use against unresolved runtime SecretRefs. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { secretRefKey } from "../../secrets/ref-contract.js";
import { SecretSurfaceUnavailableError } from "../../secrets/runtime-degraded-state.js";
import {
  assertRuntimeSandboxSecretOwnerAvailable,
  runtimeSandboxSecretOwnerId,
} from "../../secrets/runtime-sandbox-secret-owner.js";
import { listAgentEntriesWithSource, resolveAgentConfig } from "../agent-scope-config.js";
import type { SandboxScope } from "./types.js";

const SSH_SECRET_KEYS = ["identityData", "certificateData", "knownHostsData"] as const;

/** Rejects cold or unmaterialized SSH credentials before any host SSH fallback is possible. */
export function assertSshSandboxSecretOwnerAvailable(params: {
  config?: OpenClawConfig;
  scope: SandboxScope;
  agentId?: string;
}): void {
  if (params.agentId) {
    assertRuntimeSandboxSecretOwnerAvailable(params.agentId);
  }
  if (!params.config) {
    return;
  }

  const defaultsSsh = params.config.agents?.defaults?.sandbox?.ssh;
  const agentSsh =
    params.agentId && params.scope !== "shared"
      ? resolveAgentConfig(params.config, params.agentId)?.sandbox?.ssh
      : undefined;
  const normalizedAgentId = params.agentId ? normalizeAgentId(params.agentId) : undefined;
  const agentSource = normalizedAgentId
    ? listAgentEntriesWithSource(params.config).find(
        ({ entry }) => normalizeAgentId(entry.id) === normalizedAgentId,
      )?.source
    : undefined;
  const unresolved: Array<{ path: string; refKey: string }> = [];
  for (const key of SSH_SECRET_KEYS) {
    const usesAgentValue = Boolean(agentSsh && Object.hasOwn(agentSsh, key));
    const value = usesAgentValue ? agentSsh?.[key] : defaultsSsh?.[key];
    const ref = coerceSecretRef(value, params.config.secrets?.defaults);
    if (!ref) {
      continue;
    }
    unresolved.push({
      path:
        usesAgentValue && agentSource
          ? agentSource.kind === "entries"
            ? `agents.entries.${agentSource.key}.sandbox.ssh.${key}`
            : `agents.list.${agentSource.index}.sandbox.ssh.${key}`
          : `agents.defaults.sandbox.ssh.${key}`,
      refKey: secretRefKey(ref),
    });
  }
  if (unresolved.length > 0) {
    throw new SecretSurfaceUnavailableError({
      ownerKind: "capability",
      ownerId: runtimeSandboxSecretOwnerId(params.agentId ?? "shared"),
      state: "unavailable",
      paths: unresolved.map((entry) => entry.path),
      refKeys: unresolved.map((entry) => entry.refKey),
      reason: "configured SSH secret reference was not materialized",
    });
  }
}
