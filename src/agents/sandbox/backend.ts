import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
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
  SandboxFsBridgeContext,
} from "./backend-handle.types.js";

const SANDBOX_BACKEND_FACTORIES = new Map<SandboxBackendId, RegisteredSandboxBackend>();

function normalizeSandboxBackendId(id: string): SandboxBackendId {
  const normalized = normalizeOptionalLowercaseString(id);
  if (!normalized) {
    throw new Error("Sandbox backend id must not be empty.");
  }
  return normalized;
}

export function registerSandboxBackend(
  id: string,
  registration: SandboxBackendRegistration,
): () => void {
  const normalizedId = normalizeSandboxBackendId(id);
  const resolved = typeof registration === "function" ? { factory: registration } : registration;
  const previous = SANDBOX_BACKEND_FACTORIES.get(normalizedId);
  SANDBOX_BACKEND_FACTORIES.set(normalizedId, resolved);
  return () => {
    if (previous) {
      SANDBOX_BACKEND_FACTORIES.set(normalizedId, previous);
      return;
    }
    SANDBOX_BACKEND_FACTORIES.delete(normalizedId);
  };
}

export function getSandboxBackendFactory(id: string): SandboxBackendFactory | null {
  return SANDBOX_BACKEND_FACTORIES.get(normalizeSandboxBackendId(id))?.factory ?? null;
}

export function getSandboxBackendManager(id: string): SandboxBackendManager | null {
  return SANDBOX_BACKEND_FACTORIES.get(normalizeSandboxBackendId(id))?.manager ?? null;
}

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
