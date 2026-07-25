/** Parses AZURE_OPENAI_DEPLOYMENT_MAP-style model=deployment entries. */
export function parseAzureDeploymentNameMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!value) {
    return map;
  }
  for (const entry of value.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const modelId = trimmed.slice(0, separator).trim();
    const deploymentName = trimmed.slice(separator + 1).trim();
    if (!modelId || !deploymentName) {
      continue;
    }
    map.set(modelId, deploymentName);
  }
  return map;
}

interface DeploymentNameLookup {
  source: string | undefined;
  exact: Map<string, string>;
  folded: Map<string, string>;
}

let cachedDeploymentLookup: DeploymentNameLookup | undefined;

function getDeploymentLookup(source: string | undefined): DeploymentNameLookup {
  const cached = cachedDeploymentLookup;
  if (cached && cached.source === source) {
    return cached;
  }

  const exact = parseAzureDeploymentNameMap(source);
  const folded = new Map<string, string>();
  for (const [modelId, deploymentName] of exact) {
    folded.set(modelId.toLowerCase(), deploymentName);
  }

  // Process configuration is stable on hot paths; replacing one source-keyed slot
  // avoids reparsing without retaining obsolete maps or changing deployment value casing.
  cachedDeploymentLookup = { source, exact, folded };
  return cachedDeploymentLookup;
}

/**
 * Resolves the Azure deployment name for a model id, falling back to the model id.
 *
 * An exact-case match always wins, so configs that intentionally distinguish keys by
 * case keep their exact mappings; a case-insensitive match is only used as a fallback
 * (e.g. `GPT-4o` against a `gpt-4o=...` map) to avoid 404s from casing differences.
 */
export function resolveAzureDeploymentNameFromMap(params: {
  modelId: string;
  deploymentMap?: string;
}): string {
  const { exact, folded } = getDeploymentLookup(params.deploymentMap);
  return exact.get(params.modelId) ?? folded.get(params.modelId.toLowerCase()) ?? params.modelId;
}
