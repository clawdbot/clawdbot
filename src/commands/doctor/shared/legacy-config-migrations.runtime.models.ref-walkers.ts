import { getRecord } from "../../../config/legacy.shared.js";
import {
  MODEL_REF_ARRAY_KEYS,
  MODEL_REF_MAP_KEYS,
  MODEL_REF_STRING_KEYS,
  normalizeKnownModelRef,
  normalizeProviderCatalogModelId,
} from "./legacy-config-migrations.runtime.models.ref-slots.js";

export function pathKey(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

export function isChannelModelOverridePath(path: string): boolean {
  return path.includes(".modelByChannel.");
}

export function isModelPolicyAllowPath(path: string): boolean {
  return path.endsWith(".modelPolicy.allow");
}

export function isMediaModelPath(path: string): boolean {
  return ["image", "video", "music"].includes(pathKey(path)) && path.includes(".mediaModels.");
}

export function isProviderCatalogsPath(path: string): boolean {
  return path === ".providers" || path.endsWith(".models.providers");
}

function scanProviderCatalogModelIds(providers: Record<string, unknown>): boolean {
  return Object.entries(providers).some(([providerId, providerValue]) => {
    const models = getRecord(providerValue)?.models;
    return (
      Array.isArray(models) &&
      models.some((model) => {
        const modelId = getRecord(model)?.id;
        return (
          typeof modelId === "string" &&
          normalizeProviderCatalogModelId(providerId, modelId) !== modelId
        );
      })
    );
  });
}

export function scanKnownModelRefs(value: unknown, key?: string, path = ""): boolean {
  if (typeof value === "string") {
    return Boolean(
      key &&
      (MODEL_REF_STRING_KEYS.has(key) ||
        isChannelModelOverridePath(path) ||
        isMediaModelPath(path)) &&
      normalizeKnownModelRef(value),
    );
  }
  if (Array.isArray(value)) {
    return value.some((entry, index) =>
      typeof entry === "string" &&
      key &&
      (MODEL_REF_ARRAY_KEYS.has(key) || isModelPolicyAllowPath(path))
        ? Boolean(normalizeKnownModelRef(entry))
        : scanKnownModelRefs(entry, undefined, `${path}.${index}`),
    );
  }
  const record = getRecord(value);
  if (!record) {
    return false;
  }
  if (isProviderCatalogsPath(path) && scanProviderCatalogModelIds(record)) {
    return true;
  }
  if (key && MODEL_REF_MAP_KEYS.has(key)) {
    return Object.keys(record).some((entryKey) => Boolean(normalizeKnownModelRef(entryKey)));
  }
  return Object.entries(record).some(([childKey, child]) =>
    scanKnownModelRefs(child, childKey, `${path}.${childKey}`),
  );
}
