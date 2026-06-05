/**
 * Bundled channel doctor contract loader.
 *
 * Loads public doctor hooks for channel-owned legacy config rules and compatibility repairs.
 */
import type { LegacyConfigRule } from "../../config/legacy.shared.js";
import type { OpenClawConfig } from "../../config/types.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";

/**
 * Config returned after a bundled channel normalizes legacy compatibility state.
 */
type BundledChannelDoctorCompatibilityMutation = {
  config: OpenClawConfig;
  changes: string[];
};

/**
 * Public doctor hooks exported by bundled channel plugins.
 *
 * Doctor keeps these hooks channel-owned so core can run config repair without
 * importing plugin internals.
 */
type BundledChannelDoctorContractApi = {
  legacyConfigRules?: readonly LegacyConfigRule[];
  normalizeCompatibilityConfig?: (params: {
    cfg: OpenClawConfig;
  }) => BundledChannelDoctorCompatibilityMutation;
};

function loadBundledChannelPublicArtifact(
  channelId: string,
  artifactBasenames: readonly string[],
): BundledChannelDoctorContractApi | undefined {
  for (const artifactBasename of artifactBasenames) {
    try {
      return loadBundledPluginPublicArtifactModuleSync<BundledChannelDoctorContractApi>({
        dirName: channelId,
        artifactBasename,
      });
    } catch (error) {
      // Only a missing public artifact is optional. Other loader errors mean a
      // channel's doctor contract is present but broken, so surface them.
      if (
        error instanceof Error &&
        error.message.startsWith("Unable to resolve bundled plugin public surface ")
      ) {
        continue;
      }
    }
  }
  return undefined;
}

/**
 * Loads a bundled channel's public doctor contract.
 *
 * `doctor-contract-api.js` is the canonical file; `contract-api.js` remains a
 * shipped fallback for channels that exposed doctor hooks before the split.
 */
export function loadBundledChannelDoctorContractApi(
  channelId: string,
): BundledChannelDoctorContractApi | undefined {
  return loadBundledChannelPublicArtifact(channelId, ["doctor-contract-api.js", "contract-api.js"]);
}
