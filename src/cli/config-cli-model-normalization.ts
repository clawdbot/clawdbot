import { collectManifestModelIdNormalizationPolicies } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeSubmittedConfigModelRefs } from "../config/model-input-normalization.js";
import { normalizeAgentModelRefForConfig } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PathSegment } from "./config-cli-path.js";

export function normalizeConfigMutationModelRefs(cfg: OpenClawConfig): OpenClawConfig {
  const pluginMetadata = loadPluginMetadataSnapshot({ config: cfg, env: process.env });
  return normalizeSubmittedConfigModelRefs(
    cfg,
    collectManifestModelIdNormalizationPolicies(pluginMetadata.plugins),
  );
}

export function normalizeConfigMutationExplicitSetPath(path: PathSegment[]): PathSegment[] {
  const modelKeyIndex =
    path[0] === "agents" && path[1] === "defaults" && path[2] === "models"
      ? 3
      : path[0] === "agents" &&
          (path[1] === "entries" || path[1] === "list") &&
          path[3] === "models"
        ? 4
        : undefined;
  if (modelKeyIndex !== undefined && path.length > modelKeyIndex) {
    const modelId = expectDefined(path[modelKeyIndex], `path entry at ${modelKeyIndex}`);
    const normalizedModelId = normalizeAgentModelRefForConfig(modelId);
    return normalizedModelId === modelId
      ? path
      : [...path.slice(0, modelKeyIndex), normalizedModelId, ...path.slice(modelKeyIndex + 1)];
  }
  return path;
}
