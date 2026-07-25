/** Collects agent-scoped sandbox SSH SecretRefs during runtime preparation. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { resolveSandboxScope } from "../agents/sandbox/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { runtimeSandboxSecretOwnerId } from "./runtime-sandbox-secret-owner.js";
import {
  collectRuntimeSecretInputAssignment,
  type ResolverContext,
  type SecretAssignmentOwner,
  type SecretDefaults,
} from "./runtime-shared.js";
import { isRecord } from "./shared.js";

const SANDBOX_SSH_SECRET_KEYS = ["identityData", "certificateData", "knownHostsData"] as const;

type SandboxSshSecretKey = (typeof SANDBOX_SSH_SECRET_KEYS)[number];

function sandboxSecretOwner(agentId: string, contract: unknown): SecretAssignmentOwner {
  return {
    ownerKind: "capability",
    ownerId: runtimeSandboxSecretOwnerId(agentId),
    requiredForGateway: false,
    disposition: "isolate",
    contract,
  };
}

function collectAssignment(params: {
  target: Record<string, unknown>;
  key: SandboxSshSecretKey;
  path: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active: boolean;
  inactiveReason: string;
  owner: SecretAssignmentOwner;
}): void {
  collectRuntimeSecretInputAssignment({
    value: params.target[params.key],
    path: params.path,
    expected: "string",
    defaults: params.defaults,
    context: params.context,
    active: params.active,
    inactiveReason: params.inactiveReason,
    owner: params.owner,
    apply: (value) => {
      params.target[params.key] = value;
    },
  });
}

/** Collects SSH material once for every agent whose current backend can manage it. */
export function collectAgentSandboxAssignments(params: {
  config: OpenClawConfig;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
}): void {
  const rawAgents: unknown = params.config.agents;
  const agents = isRecord(rawAgents) ? rawAgents : undefined;
  if (!agents) {
    return;
  }
  const defaultsAgent = isRecord(agents.defaults) ? agents.defaults : undefined;
  const defaultsSandbox = isRecord(defaultsAgent?.sandbox) ? defaultsAgent.sandbox : undefined;
  const defaultsSsh = isRecord(defaultsSandbox?.ssh) ? defaultsSandbox.ssh : undefined;
  const defaultsBackend = normalizeOptionalLowercaseString(defaultsSandbox?.backend) ?? "docker";
  const rawEntries = isRecord(agents.entries) ? agents.entries : {};
  const configuredAgents: Array<{ entry: Record<string, unknown>; entryId: string }> = [];
  Object.entries(rawEntries).forEach(([entryId, entry]) => {
    if (isRecord(entry)) {
      configuredAgents.push({ entry, entryId });
    }
  });
  const candidates: Array<{
    entry: Record<string, unknown> | undefined;
    entryId: string | undefined;
  }> = configuredAgents.length > 0 ? configuredAgents : [{ entry: undefined, entryId: undefined }];
  const activeDefaultKeys = new Set<SandboxSshSecretKey>();
  const seenAgentIds = new Set<string>();

  for (const candidate of candidates) {
    const rawAgent = candidate.entry;
    const agentId = normalizeAgentId(candidate.entryId ?? DEFAULT_AGENT_ID);
    if (seenAgentIds.has(agentId)) {
      continue;
    }
    seenAgentIds.add(agentId);

    const sandbox = isRecord(rawAgent?.sandbox) ? rawAgent.sandbox : undefined;
    const ssh = isRecord(sandbox?.ssh) ? sandbox.ssh : undefined;
    const backend =
      normalizeOptionalLowercaseString(sandbox?.backend) ??
      normalizeOptionalLowercaseString(defaultsSandbox?.backend) ??
      "docker";
    const scope = resolveSandboxScope({
      scope:
        typeof sandbox?.scope === "string"
          ? (sandbox.scope as "agent" | "session" | "shared")
          : typeof defaultsSandbox?.scope === "string"
            ? (defaultsSandbox.scope as "agent" | "session" | "shared")
            : undefined,
      perSession:
        typeof sandbox?.perSession === "boolean"
          ? sandbox.perSession
          : typeof defaultsSandbox?.perSession === "boolean"
            ? defaultsSandbox.perSession
            : undefined,
    });
    // Existing registry entries remain inspectable/removable after an agent or its
    // sandbox is disabled, so SSH lifecycle credentials stay materialized while
    // SSH remains the configured backend.
    const active = backend === "ssh";
    const owner = sandboxSecretOwner(agentId, {
      defaults: defaultsSandbox,
      override: sandbox,
      agentEnabled: rawAgent?.enabled,
    });

    for (const key of SANDBOX_SSH_SECRET_KEYS) {
      const hasAgentOverride = Boolean(ssh && Object.hasOwn(ssh, key));
      if (hasAgentOverride && ssh) {
        if (scope !== "shared") {
          collectAssignment({
            target: ssh,
            key,
            path: `agents.entries.${candidate.entryId}.sandbox.ssh.${key}`,
            defaults: params.defaults,
            context: params.context,
            active,
            inactiveReason: "sandbox SSH backend is not configured for this agent.",
            owner,
          });
          continue;
        }
        collectAssignment({
          target: ssh,
          key,
          path: `agents.entries.${candidate.entryId}.sandbox.ssh.${key}`,
          defaults: params.defaults,
          context: params.context,
          active: false,
          inactiveReason: "shared sandbox scope ignores agent SSH overrides.",
          owner,
        });
      }

      if (!defaultsSsh || !Object.hasOwn(defaultsSsh, key)) {
        continue;
      }
      if (!active) {
        continue;
      }
      activeDefaultKeys.add(key);
      collectAssignment({
        target: defaultsSsh,
        key,
        path: `agents.defaults.sandbox.ssh.${key}`,
        defaults: params.defaults,
        context: params.context,
        active: true,
        inactiveReason: "sandbox SSH backend is not configured for this agent.",
        owner,
      });
    }
  }

  if (!defaultsSsh) {
    return;
  }
  for (const key of SANDBOX_SSH_SECRET_KEYS) {
    if (!Object.hasOwn(defaultsSsh, key) || activeDefaultKeys.has(key)) {
      continue;
    }
    // Unlisted agents and stale registry entries still resolve through defaults,
    // even when every current list entry overrides this credential.
    const active = defaultsBackend === "ssh";
    collectAssignment({
      target: defaultsSsh,
      key,
      path: `agents.defaults.sandbox.ssh.${key}`,
      defaults: params.defaults,
      context: params.context,
      active,
      inactiveReason: "no enabled agent uses the sandbox SSH material.",
      owner: sandboxSecretOwner(DEFAULT_AGENT_ID, { defaults: defaultsSandbox }),
    });
  }
}
