// Memory Core provider module implements model/runtime integration.
import {
  DEFAULT_LOCAL_MODEL,
  listMemoryEmbeddingProviders,
  type MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-embedding-registry";
import { getProviderEnvVars } from "openclaw/plugin-sdk/provider-env-vars";

export type BuiltinMemoryEmbeddingProviderDoctorMetadata = {
  providerId: string;
  authProviderId: string;
  envVars: string[];
  transport: "local" | "remote";
  autoSelectPriority?: number;
};

export { DEFAULT_LOCAL_MODEL };

function getBuiltinMemoryEmbeddingProviderAdapter(
  id: string,
): MemoryEmbeddingProviderAdapter | undefined {
  return listMemoryEmbeddingProviders().find((adapter) => adapter.id === id);
}

export function getBuiltinMemoryEmbeddingProviderDoctorMetadata(
  providerId: string,
): BuiltinMemoryEmbeddingProviderDoctorMetadata | null {
  const adapter = getBuiltinMemoryEmbeddingProviderAdapter(providerId);
  if (!adapter) {
    return null;
  }
  const authProviderId = adapter.authProviderId ?? adapter.id;
  return {
    providerId: adapter.id,
    authProviderId,
    envVars: getProviderEnvVars(authProviderId),
    transport: adapter.transport === "local" ? "local" : "remote",
    autoSelectPriority: adapter.autoSelectPriority,
  };
}

export function listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata(): Array<BuiltinMemoryEmbeddingProviderDoctorMetadata> {
  return listMemoryEmbeddingProviders()
    .filter((adapter) => typeof adapter.autoSelectPriority === "number")
    .toSorted((a, b) => (a.autoSelectPriority ?? 0) - (b.autoSelectPriority ?? 0))
    .map((adapter) => {
      const authProviderId = adapter.authProviderId ?? adapter.id;
      return {
        providerId: adapter.id,
        authProviderId,
        envVars: getProviderEnvVars(authProviderId),
        transport: adapter.transport === "local" ? "local" : "remote",
        autoSelectPriority: adapter.autoSelectPriority,
      };
    });
}
