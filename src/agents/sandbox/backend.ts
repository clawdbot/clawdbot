/**
 * Sandbox backend registry.
 *
 * Stores process-wide backend factories so core and plugins can register Docker, SSH, or custom sandbox providers.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type {
  RegisteredSandboxBackend,
  SandboxBackendFactory,
  SandboxBackendId,
  SandboxBackendManager,
  SandboxBackendRegistration,
} from "./backend.types.js";

export type {
  CreateSandboxBackendParams,
  SandboxBackendFactory,
  SandboxBackendId,
  SandboxBackendManager,
  SandboxBackendRegistration,
  SandboxBackendRuntimeInfo,
} from "./backend.types.js";
export type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendExecSpec,
  SandboxBackendHandle,
} from "./backend-handle.types.js";

const SANDBOX_BACKEND_FACTORIES_STATE_KEY = Symbol.for("openclaw.sandboxBackendFactories");

// Process-wide sandbox backend registry. Tests and plugins can install temporary
// factories while core still auto-registers the bundled Docker and SSH backends.
function getSandboxBackendFactories(): Map<SandboxBackendId, RegisteredSandboxBackend> {
  const globalStore = globalThis as typeof globalThis & {
    [SANDBOX_BACKEND_FACTORIES_STATE_KEY]?: Map<SandboxBackendId, RegisteredSandboxBackend>;
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
  const previous = factories.get(normalizedId);
  factories.set(normalizedId, resolved);
  return () => {
    const currentFactories = getSandboxBackendFactories();
    if (previous) {
      currentFactories.set(normalizedId, previous);
      return;
    }
    currentFactories.delete(normalizedId);
  };
}

/** Look up a sandbox backend factory by normalized backend id. */
export function getSandboxBackendFactory(id: string): SandboxBackendFactory | null {
  return getSandboxBackendFactories().get(normalizeSandboxBackendId(id))?.factory ?? null;
}

/** Look up optional lifecycle management hooks for a registered backend. */
export function getSandboxBackendManager(id: string): SandboxBackendManager | null {
  return getSandboxBackendFactories().get(normalizeSandboxBackendId(id))?.manager ?? null;
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

import { createDockerSandboxBackend, dockerSandboxBackendManager } from "./docker-backend.js";
import { createSshSandboxBackend, sshSandboxBackendManager } from "./ssh-backend.js";

registerSandboxBackend("docker", {
  factory: createDockerSandboxBackend,
  manager: dockerSandboxBackendManager,
});

registerSandboxBackend("ssh", {
  factory: createSshSandboxBackend,
  manager: sshSandboxBackendManager,
});
