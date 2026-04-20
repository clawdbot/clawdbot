import type { OpenClawConfig } from "../config/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { listSpeechProviders } from "./provider-registry.js";
import type {
  SpeechModelOverridePolicy,
  SpeechProviderConfig,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "./provider-types.js";

type ParseTtsDirectiveOptions = {
  cfg?: OpenClawConfig;
  providers?: readonly SpeechProviderPlugin[];
  providerConfigs?: Record<string, SpeechProviderConfig>;
  preferredProviderId?: string;
};

function buildProviderOrder(left: SpeechProviderPlugin, right: SpeechProviderPlugin): number {
  const leftOrder = left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id);
}

function resolveDirectiveProviders(options?: ParseTtsDirectiveOptions): SpeechProviderPlugin[] {
  if (options?.providers) {
    return [...options.providers].toSorted(buildProviderOrder);
  }
  return listSpeechProviders(options?.cfg).toSorted(buildProviderOrder);
}

function resolveDirectiveProviderConfig(
  provider: SpeechProviderPlugin,
  options?: ParseTtsDirectiveOptions,
): SpeechProviderConfig | undefined {
  return options?.providerConfigs?.[provider.id];
}

function prioritizeProvider(
  providers: readonly SpeechProviderPlugin[],
  providerId: string | undefined,
): SpeechProviderPlugin[] {
  if (!providerId) {
    return [...providers];
  }
  const preferredProvider = providers.find((provider) => provider.id === providerId);
  if (!preferredProvider) {
    return [...providers];
  }
  return [preferredProvider, ...providers.filter((provider) => provider.id !== providerId)];
}

export function parseTtsDirectives(
  text: string,
  policy: SpeechModelOverridePolicy,
  options?: ParseTtsDirectiveOptions,
): TtsDirectiveParseResult {
  if (!policy.enabled) {
    return { cleanedText: text, overrides: {}, warnings: [], hasDirective: false };
  }

  if (!/\[\[tts:/iu.test(text)) {
    return { cleanedText: text, overrides: {}, warnings: [], hasDirective: false };
  }

  let providers: SpeechProviderPlugin[] | undefined;
  const getProviders = () => {
    providers ??= resolveDirectiveProviders(options);
    return providers;
  };
  const overrides: TtsDirectiveOverrides = {};
  const warnings: string[] = [];
  let cleanedText = text;
  let hasDirective = false;

  const blockRegex = /\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/gi;
  cleanedText = cleanedText.replace(blockRegex, (_match, inner: string) => {
    hasDirective = true;
    if (policy.allowText && overrides.ttsText == null) {
      overrides.ttsText = inner.trim();
    }
    return "";
  });

  const directiveRegex = /\[\[tts:([^\]]+)\]\]/gi;
  cleanedText = cleanedText.replace(directiveRegex, (_match, body: string) => {
    hasDirective = true;
    const tokens = body.split(/\s+/).filter(Boolean);

    let declaredProviderId: string | undefined;
    if (policy.allowProvider) {
      for (const token of tokens) {
        const eqIndex = token.indexOf("=");
        if (eqIndex === -1) {
          continue;
        }
        const rawKey = token.slice(0, eqIndex).trim();
        if (!rawKey || normalizeLowercaseStringOrEmpty(rawKey) !== "provider") {
          continue;
        }
        const rawValue = token.slice(eqIndex + 1).trim();
        if (!rawValue) {
          continue;
        }
        const providerId = normalizeLowercaseStringOrEmpty(rawValue);
        if (!providerId) {
          warnings.push("invalid provider id");
          continue;
        }
        declaredProviderId = providerId;
        overrides.provider = providerId;
      }
    }

    let orderedProviders: SpeechProviderPlugin[] | undefined;
    const getOrderedProviders = () => {
      orderedProviders ??= prioritizeProvider(
        getProviders(),
        declaredProviderId ?? normalizeLowercaseStringOrEmpty(options?.preferredProviderId),
      );
      return orderedProviders;
    };

    for (const token of tokens) {
      const eqIndex = token.indexOf("=");
      if (eqIndex === -1) {
        continue;
      }
      const rawKey = token.slice(0, eqIndex).trim();
      const rawValue = token.slice(eqIndex + 1).trim();
      if (!rawKey || !rawValue) {
        continue;
      }
      const key = normalizeLowercaseStringOrEmpty(rawKey);
      if (key === "provider") {
        continue;
      }

      for (const provider of getOrderedProviders()) {
        const parsed = provider.parseDirectiveToken?.({
          key,
          value: rawValue,
          policy,
          providerConfig: resolveDirectiveProviderConfig(provider, options),
          currentOverrides: overrides.providerOverrides?.[provider.id],
        });
        if (!parsed?.handled) {
          continue;
        }
        if (parsed.overrides) {
          overrides.providerOverrides = {
            ...overrides.providerOverrides,
            [provider.id]: {
              ...overrides.providerOverrides?.[provider.id],
              ...parsed.overrides,
            },
          };
        }
        if (parsed.warnings?.length) {
          warnings.push(...parsed.warnings);
        }
        break;
      }
    }
    return "";
  });

  return {
    cleanedText,
    ttsText: overrides.ttsText,
    hasDirective,
    overrides,
    warnings,
  };
}
