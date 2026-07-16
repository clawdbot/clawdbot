import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "openclaw/plugin-sdk/text-runtime";

const ELEVENLABS_API_KEY_ENV = "ELEVENLABS_API_KEY";
const PROFILE_CANDIDATES = [".profile", ".zprofile", ".zshrc", ".bashrc"] as const;
const LEGACY_TALK_FIELD_KEYS = [
  "voiceId",
  "voiceAliases",
  "modelId",
  "outputFormat",
  "apiKey",
] as const;

type JsonRecord = Record<string, unknown>;

type ElevenLabsApiKeyDeps = {
  fs?: typeof fs;
  os?: typeof os;
  path?: typeof path;
};

export const ELEVENLABS_TALK_PROVIDER_ID = "elevenlabs";

function getRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function ensureRecord(root: JsonRecord, key: string): JsonRecord {
  const existing = getRecord(root[key]);
  if (existing) {
    return existing;
  }
  const next: JsonRecord = {};
  root[key] = next;
  return next;
}

function isBlockedObjectKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function mergeMissing(target: JsonRecord, source: JsonRecord): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isBlockedObjectKey(key)) {
      continue;
    }
    const existing = target[key];
    if (existing === undefined) {
      target[key] = value;
      continue;
    }
    if (isRecord(existing) && isRecord(value)) {
      mergeMissing(existing, value);
    }
  }
}

function hasLegacyTalkFields(value: unknown): value is JsonRecord {
  const talk = getRecord(value);
  if (!talk) {
    return false;
  }
  return LEGACY_TALK_FIELD_KEYS.some((key) => Object.prototype.hasOwnProperty.call(talk, key));
}

function resolveTalkMigrationTargetProviderId(talk: JsonRecord): string | null {
  const explicitProvider =
    typeof talk.provider === "string" && talk.provider.trim() ? talk.provider.trim() : null;
  const providers = getRecord(talk.providers);
  if (explicitProvider) {
    if (isBlockedObjectKey(explicitProvider)) {
      return null;
    }
    return explicitProvider;
  }
  if (!providers) {
    return ELEVENLABS_TALK_PROVIDER_ID;
  }
  const providerIds = Object.keys(providers).filter((key) => !isBlockedObjectKey(key));
  if (providerIds.length === 0) {
    return ELEVENLABS_TALK_PROVIDER_ID;
  }
  if (providerIds.length === 1) {
    return providerIds[0] ?? null;
  }
  return null;
}

export function migrateElevenLabsLegacyTalkConfig<T>(raw: T): { config: T; changes: string[] } {
  if (!isRecord(raw)) {
    return { config: raw, changes: [] };
  }

  const talk = getRecord(raw.talk);
  if (!talk || !hasLegacyTalkFields(talk)) {
    return { config: raw, changes: [] };
  }

  const providerId = resolveTalkMigrationTargetProviderId(talk);
  if (!providerId) {
    return {
      config: raw,
      changes: [
        "Skipped talk legacy field migration because talk.providers defines multiple providers and talk.provider is unset; move talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey under the intended provider manually.",
      ],
    };
  }

  const nextRoot = structuredClone(raw) as JsonRecord;
  const nextTalk = ensureRecord(nextRoot, "talk");
  const providers = ensureRecord(nextTalk, "providers");
  const existingProvider = getRecord(providers[providerId]) ?? {};
  const migratedProvider = structuredClone(existingProvider);
  const legacyFields: JsonRecord = {};
  const movedKeys: string[] = [];

  for (const key of LEGACY_TALK_FIELD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(nextTalk, key)) {
      continue;
    }
    legacyFields[key] = nextTalk[key];
    delete nextTalk[key];
    movedKeys.push(key);
  }

  if (movedKeys.length === 0) {
    return { config: raw, changes: [] };
  }

  mergeMissing(migratedProvider, legacyFields);
  providers[providerId] = migratedProvider;
  nextTalk.providers = providers;
  nextRoot.talk = nextTalk;

  return {
    config: nextRoot as T,
    changes: [
      `Moved talk legacy fields (${movedKeys.join(", ")}) → talk.providers.${providerId} (filled missing provider fields only).`,
    ],
  };
}

function readApiKeyFromProfile(deps: ElevenLabsApiKeyDeps = {}): string | null {
  const fsImpl = deps.fs ?? fs;
  const osImpl = deps.os ?? os;
  const pathImpl = deps.path ?? path;

  const home = osImpl.homedir();
  for (const candidate of PROFILE_CANDIDATES) {
    const fullPath = pathImpl.join(home, candidate);
    if (!fsImpl.existsSync(fullPath)) {
      continue;
    }
    try {
      const text = fsImpl.readFileSync(fullPath, "utf-8");
      const match = text.match(
        /(?:^|\n)\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*["']?([^\n"']+)["']?/,
      );
      const value = match?.[1]?.trim();
      if (value) {
        return value;
      }
    } catch {
      // Ignore profile read errors.
    }
  }
  return null;
}

export function resolveElevenLabsApiKeyWithProfileFallback(
  env: NodeJS.ProcessEnv = process.env,
  deps: ElevenLabsApiKeyDeps = {},
): string | null {
  const envValue = (env[ELEVENLABS_API_KEY_ENV] ?? "").trim();
  if (envValue) {
    return envValue;
  }
  return readApiKeyFromProfile(deps);
}
