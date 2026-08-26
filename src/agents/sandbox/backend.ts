/**
 * Sandbox backend registry.
 *
 * Stores process-wide backend factories so core and plugins can register local container, SSH, or custom sandbox providers.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type {
  RegisteredSandboxBackend,
  SandboxBackendFactory,
  SandboxBackendId,
  SandboxBackendManager,
  SandboxBackendRegistration,
  SandboxBackendWorkdirResolver,
} from "./backend.types.js";
import {
  createDockerSandboxBackend,
  createPodmanSandboxBackend,
  dockerSandboxBackendManager,
  podmanSandboxBackendManager,
} from "./docker-backend.js";
import {
  createSshSandboxBackend,
  resolveSshRuntimePaths,
  sshSandboxBackendManager,
} from "./ssh-backend.js";

export type {
  CreateSandboxBackendParams,
  SandboxBackendFactory,
  SandboxBackendId,
  SandboxBackendManager,
  SandboxBackendRegistration,
  SandboxBackendRuntimeInfo,
  SandboxBackendWorkdirValidation,
  SandboxBackendWorkdirResolver,
} from "./backend.types.js";
export type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendExecSpec,
  SandboxBackendHandle,
  SandboxBackendPreparedWorkdirDiscarder,
  SandboxBackendWorkdirValidator,
} from "./backend-handle.types.js";

const SANDBOX_BACKEND_FACTORIES_STATE_KEY = Symbol.for("openclaw.sandboxBackendFactories");

type SandboxBackendRegistrationGeneration = {
  registration: RegisteredSandboxBackend;
  previous: SandboxBackendRegistrationGeneration | undefined;
  retired: boolean;
};

// Process-wide sandbox backend registry. Tests and plugins can install temporary
// factories while core still auto-registers the bundled container and SSH backends.
function getSandboxBackendFactories(): Map<SandboxBackendId, SandboxBackendRegistrationGeneration> {
  const globalStore = globalThis as typeof globalThis & {
    [SANDBOX_BACKEND_FACTORIES_STATE_KEY]?: Map<
      SandboxBackendId,
      SandboxBackendRegistrationGeneration
    >;
  };
  globalStore[SANDBOX_BACKEND_FACTORIES_STATE_KEY] ??= new Map();
  return globalStore[SANDBOX_BACKEND_FACTORIES_STATE_KEY];
}

function normalizeSandboxBackendId(id: string): SandboxBackendId {
  const normalized = normalizeOptionalLowercaseString(id);
  if (!normalized) {
    throw new Error("Sandbox backend id must not be empty.");
  }
  return normalized;
}

/** Register or replace a sandbox backend and return a restore callback. */
export function registerSandboxBackend(
  id: string,
  registration: SandboxBackendRegistration,
): () => void {
  const normalizedId = normalizeSandboxBackendId(id);
  const resolved = typeof registration === "function" ? { factory: registration } : registration;
  const factories = getSandboxBackendFactories();
  const generation: SandboxBackendRegistrationGeneration = {
    registration: resolved,
    previous: factories.get(normalizedId),
    retired: false,
  };
  factories.set(normalizedId, generation);
  return () => {
    if (generation.retired) {
      return;
    }
    generation.retired = true;
    if (factories.get(normalizedId) !== generation) {
      return;
    }
    // Older disposers can run before newer plugin generations retire. Skip
    // every retired predecessor so stale sandbox authority never returns.
    let previous = generation.previous;
    while (previous?.retired) {
      previous = previous.previous;
    }
    if (previous) {
      factories.set(normalizedId, previous);
      return;
    }
    factories.delete(normalizedId);
  };
}

/** Look up a sandbox backend factory by normalized backend id. */
export function getSandboxBackendFactory(id: string): SandboxBackendFactory | null {
  return (
    getSandboxBackendFactories().get(normalizeSandboxBackendId(id))?.registration.factory ?? null
  );
}

/** Look up optional lifecycle management hooks for a registered backend. */
export function getSandboxBackendManager(id: string): SandboxBackendManager | null {
  return (
    getSandboxBackendFactories().get(normalizeSandboxBackendId(id))?.registration.manager ?? null
  );
}

/** Look up optional backend workdir resolution that does not start the runtime. */
export function getSandboxBackendWorkdirResolver(id: string): SandboxBackendWorkdirResolver | null {
  return (
    getSandboxBackendFactories().get(normalizeSandboxBackendId(id))?.registration.resolveWorkdir ??
    null
  );
}

/** Resolve a backend factory or throw the user-facing configuration error. */
export function requireSandboxBackendFactory(id: string): SandboxBackendFactory {
  const factory = getSandboxBackendFactory(id);
  if (factory) {
    return factory;
  }
  throw new Error(
    [
      `Sandbox backend "${id}" is not registered.`,
      "Load the plugin that provides it, or set agents.defaults.sandbox.backend=docker.",
    ].join("\n"),
  );
}

registerSandboxBackend("docker", {
  factory: createDockerSandboxBackend,
  manager: dockerSandboxBackendManager,
  resolveWorkdir: ({ cfg }) => cfg.docker.workdir,
});

registerSandboxBackend("podman", {
  factory: createPodmanSandboxBackend,
  manager: podmanSandboxBackendManager,
  resolveWorkdir: ({ cfg }) => cfg.docker.workdir,
});

registerSandboxBackend("ssh", {
  factory: createSshSandboxBackend,
  manager: sshSandboxBackendManager,
  resolveWorkdir: ({ cfg, scopeKey }) =>
    resolveSshRuntimePaths(cfg.ssh.workspaceRoot, scopeKey).remoteWorkspaceDir,
});
