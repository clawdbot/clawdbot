import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import type { ResolverContext, SecretDefaults } from "./runtime-shared.js";
import type { SecretTargetRegistryEntry } from "./target-registry-types.js";

type UnsupportedSecretRefConfigCandidate = {
  path: string;
  value: unknown;
};

type BundledChannelContractApi = {
  collectRuntimeConfigAssignments?: (params: {
    config: OpenClawConfig;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
  }) => void;
  secretTargetRegistryEntries?: readonly SecretTargetRegistryEntry[];
  unsupportedSecretRefSurfacePatterns?: readonly string[];
  collectUnsupportedSecretRefConfigCandidates?: (
    raw: Record<string, unknown>,
  ) => UnsupportedSecretRefConfigCandidate[];
};

function loadBundledChannelPublicArtifact(
  channelId: string,
  artifactBasenames: readonly string[],
): BundledChannelContractApi | undefined {
  for (const artifactBasename of artifactBasenames) {
    try {
      return loadBundledPluginPublicArtifactModuleSync<BundledChannelContractApi>({
        dirName: channelId,
        artifactBasename,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
      if (process.env.OPENCLAW_DEBUG_CHANNEL_CONTRACT_API === "1") {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `[channel-contract-api] failed to load ${channelId}/${artifactBasename}: ${detail}\n`,
        );
      }
    }
  }
  return undefined;
}

export type BundledChannelSecretContractApi = Pick<
  BundledChannelContractApi,
  "collectRuntimeConfigAssignments" | "secretTargetRegistryEntries"
>;

export function loadBundledChannelSecretContractApi(
  channelId: string,
): BundledChannelSecretContractApi | undefined {
  return loadBundledChannelPublicArtifact(channelId, ["secret-contract-api.js", "contract-api.js"]);
}

export type BundledChannelSecurityContractApi = Pick<
  BundledChannelContractApi,
  "unsupportedSecretRefSurfacePatterns" | "collectUnsupportedSecretRefConfigCandidates"
>;

export function loadBundledChannelSecurityContractApi(
  channelId: string,
): BundledChannelSecurityContractApi | undefined {
  return loadBundledChannelPublicArtifact(channelId, ["security-contract-api.js"]);
}
