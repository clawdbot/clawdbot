/** Collects agent-scoped sandbox SecretRefs during runtime preparation. */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntriesWithSource, resolveDefaultAgentId } from "../agents/agent-scope-config.js";
import { resolveSandboxScope } from "../agents/sandbox/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
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

function isSandboxModeActive(mode: unknown): boolean {
  const normalized = normalizeOptionalLowercaseString(mode);
  return normalized === "all" || normalized === "non-main";
}

function sandboxSecretOwner(agentId: string, contract: unknown): SecretAssignmentOwner {
  return {
    ownerKind: "capability",
    ownerId: runtimeSandboxSecretOwnerId(agentId),
    requiredForGateway: false,
    disposition: "isolate",
    contract,
  };
}

function collectSshAssignment(params: {
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

function collectDockerEnvAssignments(params: {
  env: Record<string, unknown>;
  pathPrefix: string;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  active: boolean;
  inactiveReason: string;
  owner: SecretAssignmentOwner;
  skipKeys?: ReadonlySet<string>;
}): void {
  for (const [key, value] of Object.entries(params.env)) {
    if (params.skipKeys?.has(key)) {
      continue;
    }
    collectRuntimeSecretInputAssignment({
      value,
      path: `${params.pathPrefix}.${key}`,
      expected: "string",
      defaults: params.defaults,
      context: params.context,
      active: params.active,
      inactiveReason: params.inactiveReason,
      owner: params.owner,
      apply: (resolved) => {
        params.env[key] = resolved;
      },
    });
  }
}

/** Collects Docker env and SSH material for every agent that can use it. */
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
  const defaultsDocker = isRecord(defaultsSandbox?.docker) ? defaultsSandbox.docker : undefined;
  const defaultsDockerEnv = isRecord(defaultsDocker?.env) ? defaultsDocker.env : undefined;
  const defaultsSsh = isRecord(defaultsSandbox?.ssh) ? defaultsSandbox.ssh : undefined;
  const defaultsBackend = normalizeOptionalLowercaseString(defaultsSandbox?.backend) ?? "docker";
  const defaultsMode = normalizeOptionalLowercaseString(defaultsSandbox?.mode) ?? "off";
  const candidates = listAgentEntriesWithSource(params.config).map(({ entry, source }) => ({
    entry,
    entryId: entry.id,
    agentPath:
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list.${source.index}`,
  }));
  const activeDefaultKeys = new Set<SandboxSshSecretKey>();
  const activeDefaultDockerEnvKeys = new Set<string>();
  const seenAgentIds = new Set<string>();

  for (const candidate of candidates) {
    const rawAgent = candidate.entry;
    const rawAgentRecord = rawAgent as unknown as Record<string, unknown>;
    const agentId = normalizeAgentId(candidate.entryId);
    if (seenAgentIds.has(agentId)) {
      continue;
    }
    seenAgentIds.add(agentId);

    const sandbox = isRecord(rawAgentRecord.sandbox) ? rawAgentRecord.sandbox : undefined;
    const docker = isRecord(sandbox?.docker) ? sandbox.docker : undefined;
    const dockerEnv = isRecord(docker?.env) ? docker.env : undefined;
    const ssh = isRecord(sandbox?.ssh) ? sandbox.ssh : undefined;
    const backend =
      normalizeOptionalLowercaseString(sandbox?.backend) ??
      normalizeOptionalLowercaseString(defaultsSandbox?.backend) ??
      "docker";
    const mode =
      normalizeOptionalLowercaseString(sandbox?.mode) ??
      normalizeOptionalLowercaseString(defaultsSandbox?.mode) ??
      "off";
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
    const sshActive = backend === "ssh";
    const dockerActive =
      rawAgentRecord.enabled !== false && backend === "docker" && isSandboxModeActive(mode);
    const owner = sandboxSecretOwner(agentId, {
      defaults: defaultsSandbox,
      override: sandbox,
      agentEnabled: rawAgentRecord.enabled,
    });

    if (dockerEnv) {
      const sharedOverride = scope === "shared";
      collectDockerEnvAssignments({
        env: dockerEnv,
        pathPrefix: `${candidate.agentPath}.sandbox.docker.env`,
        defaults: params.defaults,
        context: params.context,
        active: dockerActive && !sharedOverride,
        inactiveReason: sharedOverride
          ? "shared sandbox scope ignores agent Docker env overrides."
          : "sandbox Docker backend is not active for this agent.",
        owner,
      });
    }
    if (defaultsDockerEnv && dockerActive) {
      const overriddenKeys =
        scope !== "shared" && dockerEnv ? new Set(Object.keys(dockerEnv)) : undefined;
      for (const key of Object.keys(defaultsDockerEnv)) {
        if (!overriddenKeys?.has(key)) {
          activeDefaultDockerEnvKeys.add(key);
        }
      }
      collectDockerEnvAssignments({
        env: defaultsDockerEnv,
        pathPrefix: "agents.defaults.sandbox.docker.env",
        defaults: params.defaults,
        context: params.context,
        active: true,
        inactiveReason: "sandbox Docker backend is not active for this agent.",
        owner,
        skipKeys: overriddenKeys,
      });
    }

    for (const key of SANDBOX_SSH_SECRET_KEYS) {
      const hasAgentOverride = Boolean(ssh && Object.hasOwn(ssh, key));
      if (hasAgentOverride && ssh) {
        if (scope !== "shared") {
          collectSshAssignment({
            target: ssh,
            key,
            path: `${candidate.agentPath}.sandbox.ssh.${key}`,
            defaults: params.defaults,
            context: params.context,
            active: sshActive,
            inactiveReason: "sandbox SSH backend is not configured for this agent.",
            owner,
          });
          continue;
        }
        collectSshAssignment({
          target: ssh,
          key,
          path: `${candidate.agentPath}.sandbox.ssh.${key}`,
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
      if (!sshActive) {
        continue;
      }
      activeDefaultKeys.add(key);
      collectSshAssignment({
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

  if (defaultsDockerEnv) {
    const defaultsOnlyActive =
      candidates.length === 0 && defaultsBackend === "docker" && isSandboxModeActive(defaultsMode);
    if (defaultsOnlyActive) {
      for (const key of Object.keys(defaultsDockerEnv)) {
        activeDefaultDockerEnvKeys.add(key);
      }
      collectDockerEnvAssignments({
        env: defaultsDockerEnv,
        pathPrefix: "agents.defaults.sandbox.docker.env",
        defaults: params.defaults,
        context: params.context,
        active: true,
        inactiveReason: "sandbox Docker backend is not active.",
        owner: sandboxSecretOwner(resolveDefaultAgentId(params.config), {
          defaults: defaultsSandbox,
        }),
      });
    }

    const inactiveKeys = new Set(
      Object.keys(defaultsDockerEnv).filter((key) => !activeDefaultDockerEnvKeys.has(key)),
    );
    if (inactiveKeys.size > 0) {
      const activeKeys = new Set(
        Object.keys(defaultsDockerEnv).filter((key) => !inactiveKeys.has(key)),
      );
      collectDockerEnvAssignments({
        env: defaultsDockerEnv,
        pathPrefix: "agents.defaults.sandbox.docker.env",
        defaults: params.defaults,
        context: params.context,
        active: false,
        inactiveReason: "no enabled agent inherits this sandbox Docker env value.",
        owner: sandboxSecretOwner(resolveDefaultAgentId(params.config), {
          defaults: defaultsSandbox,
        }),
        skipKeys: activeKeys,
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
    collectSshAssignment({
      target: defaultsSsh,
      key,
      path: `agents.defaults.sandbox.ssh.${key}`,
      defaults: params.defaults,
      context: params.context,
      active,
      inactiveReason: "no enabled agent uses the sandbox SSH material.",
      owner: sandboxSecretOwner(resolveDefaultAgentId(params.config), {
        defaults: defaultsSandbox,
      }),
    });
  }
}
