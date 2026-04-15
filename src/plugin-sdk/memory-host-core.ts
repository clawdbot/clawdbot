import { resolveDefaultAgentId, resolveSessionAgentId, type MemoryPromptSectionBuilder } from "./memory-core-host-runtime-core.js";
import type { OpenClawConfig } from "./memory-core-host-engine-foundation.js";

export { resolveDefaultAgentId, resolveSessionAgentId, type MemoryPromptSectionBuilder };

export type MemoryPluginPublicArtifact = {
  kind: "memory-root" | "daily-note" | "dream-report" | "event-log";
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  agentIds: string[];
  contentType: "markdown" | "json";
};

type MemoryCapabilityArtifactProvider = {
  listArtifacts?: (params: { cfg: OpenClawConfig }) => Promise<MemoryPluginPublicArtifact[]>;
};

type MemoryCapabilityRegistry = {
  values?: () => Iterable<MemoryCapabilityArtifactProvider>;
  [Symbol.iterator]?: () => Iterator<MemoryCapabilityArtifactProvider>;
};

const MEMORY_PUBLIC_ARTIFACT_REGISTRY_SYMBOL = Symbol.for("openclaw.memoryPluginCapabilityRegistry");

function readMemoryCapabilityRegistry(): MemoryCapabilityRegistry | null {
  const value = (globalThis as Record<PropertyKey, unknown>)[MEMORY_PUBLIC_ARTIFACT_REGISTRY_SYMBOL];
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as MemoryCapabilityRegistry;
}

function listRegistryValues(registry: MemoryCapabilityRegistry): MemoryCapabilityArtifactProvider[] {
  if (typeof registry.values === "function") {
    return [...registry.values()];
  }
  if (typeof registry[Symbol.iterator] === "function") {
    return [...registry];
  }
  return [];
}

export async function listActiveMemoryPublicArtifacts(params: {
  cfg: OpenClawConfig;
}): Promise<MemoryPluginPublicArtifact[]> {
  const registry = readMemoryCapabilityRegistry();
  if (!registry) {
    return [];
  }
  const artifacts = await Promise.all(
    listRegistryValues(registry).map(async (capability) =>
      typeof capability.listArtifacts === "function"
        ? await capability.listArtifacts({ cfg: params.cfg })
        : [],
    ),
  );
  return artifacts
    .flat()
    .toSorted((left, right) =>
      `${left.workspaceDir}\0${left.relativePath}\0${left.kind}`.localeCompare(
        `${right.workspaceDir}\0${right.relativePath}\0${right.kind}`,
      ),
    );
}
