// Reads provider ids selected by auth, model, channel, and media configuration.
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeNullableString as normalizeId } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { asObjectRecord } from "./object.js";

function collectConfiguredProviderIds(cfg: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const id = normalizeId(value);
    if (id) {
      ids.add(id.toLowerCase());
    }
  };
  for (const profile of Object.values(asObjectRecord(cfg.auth?.profiles) ?? {})) {
    add(asObjectRecord(profile)?.provider);
  }
  for (const providerId of Object.keys(asObjectRecord(cfg.models?.providers) ?? {})) {
    add(providerId);
  }
  const modelByChannel = asObjectRecord(cfg.channels?.modelByChannel);
  for (const [providerId, channelMap] of Object.entries(modelByChannel ?? {})) {
    add(providerId);
    for (const modelRef of Object.values(asObjectRecord(channelMap) ?? {})) {
      if (typeof modelRef !== "string") {
        continue;
      }
      const slash = modelRef.indexOf("/");
      if (slash > 0) {
        add(modelRef.slice(0, slash));
      }
    }
  }
  for (const { value } of collectConfiguredModelRefs(cfg, {
    includeChannelModelOverrides: false,
  })) {
    const slash = value.indexOf("/");
    if (slash > 0) {
      add(value.slice(0, slash));
    }
  }
  return ids;
}

function collectConfiguredMediaProviderIds(cfg: OpenClawConfig): Set<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const id = normalizeId(value);
    if (id) {
      ids.add(id.toLowerCase());
    }
  };
  const addModels = (value: unknown) => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const model of value) {
      add(asObjectRecord(model)?.provider);
    }
  };
  const media = cfg.tools?.media;
  addModels(media?.models);
  return ids;
}

/** Provider ids used by static and installed-registry plugin matching. */
export function collectConfiguredProviderSelectionIds(cfg: OpenClawConfig): ReadonlySet<string> {
  return new Set([...collectConfiguredProviderIds(cfg), ...collectConfiguredMediaProviderIds(cfg)]);
}

export function collectConfiguredMediaProviderSelectionIds(
  cfg: OpenClawConfig,
): ReadonlySet<string> {
  return collectConfiguredMediaProviderIds(cfg);
}

export function collectConfiguredModelProviderSelectionIds(
  cfg: OpenClawConfig,
): ReadonlySet<string> {
  return collectConfiguredProviderIds(cfg);
}
