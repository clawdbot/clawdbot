import { isDeepStrictEqual } from "node:util";
import { normalizeTalkSection } from "../../../config/talk.js";
import type { OpenClawConfig } from "../../../config/types.js";

function buildLegacyTalkProviderCompat(
  talk: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const compat: Record<string, unknown> = {};
  for (const key of ["voiceId", "voiceAliases", "modelId", "outputFormat", "apiKey"] as const) {
    if (talk[key] !== undefined) {
      compat[key] = talk[key];
    }
  }
  return Object.keys(compat).length > 0 ? compat : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizeLegacyTalkConfig(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  const rawTalk = cfg.talk;
  if (!isRecord(rawTalk)) {
    return cfg;
  }

  const normalizedTalk = normalizeTalkSection(rawTalk as OpenClawConfig["talk"]) ?? {};
  const legacyProviderCompat = buildLegacyTalkProviderCompat(rawTalk);
  if (legacyProviderCompat) {
    normalizedTalk.providers = {
      ...normalizedTalk.providers,
      elevenlabs: {
        ...legacyProviderCompat,
        ...normalizedTalk.providers?.elevenlabs,
      },
    };
  }
  if (Object.keys(normalizedTalk).length === 0 || isDeepStrictEqual(normalizedTalk, rawTalk)) {
    return cfg;
  }

  changes.push(
    "Normalized talk.provider/providers shape (trimmed provider ids and merged missing compatibility fields).",
  );
  return {
    ...cfg,
    talk: normalizedTalk,
  };
}
