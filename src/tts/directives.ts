// TTS directive helpers parse inline speech directives from text.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import type { AssistantDeliveryTtsFacts } from "../llm/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { extractTtsDirectiveFacts } from "./directive-facts.js";
import { listSpeechProviders } from "./provider-registry.js";
import type {
  SpeechModelOverridePolicy,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "./provider-types.js";

type ParseTtsDirectiveOptions = {
  cfg?: OpenClawConfig;
  providers?: readonly SpeechProviderPlugin[];
  providerConfigs?: Record<string, SpeechProviderConfig>;
  preferredProviderId?: string;
};

/** Streaming cleaner used to strip TTS tags before final text parsing is available. */
type TtsDirectiveTextStreamCleaner = {
  push: (text: string) => string;
  flush: () => string;
  hasBufferedDirectiveText: () => boolean;
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
  const preferredProvider = resolveDirectiveProvider(providers, providerId);
  if (!preferredProvider) {
    return [...providers];
  }
  return [
    preferredProvider,
    ...providers.filter((provider) => provider.id !== preferredProvider.id),
  ];
}

function resolveDirectiveProvider(
  providers: readonly SpeechProviderPlugin[],
  providerId: string,
): SpeechProviderPlugin | undefined {
  const normalized = normalizeLowercaseStringOrEmpty(providerId);
  if (!normalized) {
    return undefined;
  }
  return providers.find(
    (provider) =>
      provider.id === normalized ||
      provider.aliases?.some((alias) => normalizeLowercaseStringOrEmpty(alias) === normalized),
  );
}

function parseGenericSpeakerDirective(params: {
  key: string;
  value: string;
  policy: SpeechModelOverridePolicy;
  currentOverrides?: SpeechProviderOverrides;
}): SpeechProviderOverrides | undefined {
  if (!params.policy.allowVoice) {
    return undefined;
  }
  switch (params.key) {
    case "speakervoice":
    case "speaker_voice":
      return {
        ...params.currentOverrides,
        speakerVoice: params.value,
        voice: params.value,
        voiceName: params.value,
      };
    case "speakervoiceid":
    case "speaker_voice_id":
      return {
        ...params.currentOverrides,
        speakerVoiceId: params.value,
        voiceId: params.value,
      };
    default:
      return undefined;
  }
}

function normalizeTtsTagBody(body: string): string {
  return body.trim().replace(/\s+/g, "").toLowerCase();
}

function classifyTtsTag(body: string): "hidden-open" | "hidden-close" | "tts" | "other" {
  const normalized = normalizeTtsTagBody(body);
  if (normalized === "tts:text") {
    return "hidden-open";
  }
  if (normalized === "/tts:text") {
    return "hidden-close";
  }
  if (
    normalized === "tts" ||
    normalized.startsWith("tts:") ||
    normalized === "/tts" ||
    normalized.startsWith("/tts:")
  ) {
    return "tts";
  }
  return "other";
}

/** Create an incremental cleaner for hiding [[tts:*]] directive text while streaming. */
export function createTtsDirectiveTextStreamCleaner(): TtsDirectiveTextStreamCleaner {
  let pending = "";
  let insideHiddenTextBlock = false;

  return {
    push(text: string): string {
      const input = pending + text;
      pending = "";
      let output = "";
      let index = 0;

      while (index < input.length) {
        const tagStart = input.indexOf("[[", index);
        if (tagStart === -1) {
          if (!insideHiddenTextBlock) {
            output += input.slice(index);
          }
          break;
        }

        if (!insideHiddenTextBlock) {
          output += input.slice(index, tagStart);
        }

        const tagEnd = input.indexOf("]]", tagStart + 2);
        if (tagEnd === -1) {
          // Directive delimiters can cross chunk boundaries; buffer from the
          // opener so a partial tag never leaks to a streamed client.
          pending = input.slice(tagStart);
          break;
        }

        const rawTag = input.slice(tagStart, tagEnd + 2);
        const tag = classifyTtsTag(input.slice(tagStart + 2, tagEnd));
        if (tag === "hidden-open") {
          insideHiddenTextBlock = true;
        } else if (tag === "hidden-close") {
          insideHiddenTextBlock = false;
        } else if (tag === "other" && !insideHiddenTextBlock) {
          output += rawTag;
        }

        index = tagEnd + 2;
      }

      return output;
    },
    flush(): string {
      const tail = pending;
      pending = "";
      return insideHiddenTextBlock ? "" : tail;
    },
    hasBufferedDirectiveText(): boolean {
      return pending.length > 0 || insideHiddenTextBlock;
    },
  };
}

/** Resolve persisted TTS facts against the active model/provider policy. */
export function resolveTtsDirectiveFacts(
  facts: AssistantDeliveryTtsFacts | undefined,
  policy: SpeechModelOverridePolicy,
  options?: ParseTtsDirectiveOptions,
): Omit<TtsDirectiveParseResult, "cleanedText"> {
  if (!facts || !policy.enabled) {
    return { overrides: {}, warnings: [], hasDirective: false };
  }

  let providers: SpeechProviderPlugin[] | undefined;
  const getProviders = () => {
    providers ??= resolveDirectiveProviders(options);
    return providers;
  };
  const overrides: TtsDirectiveOverrides = {};
  const warnings: string[] = [];
  if (policy.allowText && facts.text != null) {
    overrides.ttsText = facts.text;
  }

  for (const directive of facts.directives ?? []) {
    const declaredProviderId = policy.allowProvider ? directive.provider : undefined;
    if (declaredProviderId) {
      overrides.provider = declaredProviderId;
    }
    let directiveProviders: SpeechProviderPlugin[] | undefined;
    const getDirectiveProviders = () => {
      if (directiveProviders) {
        return directiveProviders;
      }
      if (declaredProviderId) {
        const declaredProvider = resolveDirectiveProvider(getProviders(), declaredProviderId);
        if (!declaredProvider) {
          warnings.push(`unknown provider "${declaredProviderId}"`);
          directiveProviders = [];
          return directiveProviders;
        }
        directiveProviders = [declaredProvider];
        return directiveProviders;
      }
      directiveProviders = prioritizeProvider(
        getProviders(),
        normalizeLowercaseStringOrEmpty(options?.preferredProviderId),
      );
      return directiveProviders;
    };

    for (const [key, value] of Object.entries(directive.values)) {
      let handled = false;
      const directiveProvidersLocal = getDirectiveProviders();
      for (const provider of directiveProvidersLocal) {
        const genericSpeakerOverrides = parseGenericSpeakerDirective({
          key,
          value,
          policy,
          currentOverrides: overrides.providerOverrides?.[provider.id],
        });
        if (genericSpeakerOverrides) {
          overrides.providerOverrides = {
            ...overrides.providerOverrides,
            [provider.id]: {
              ...overrides.providerOverrides?.[provider.id],
              ...genericSpeakerOverrides,
            },
          };
          handled = true;
          break;
        }
        const parsed = provider.parseDirectiveToken?.({
          key,
          value,
          policy,
          selectedProvider: declaredProviderId ? provider.id : undefined,
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
        handled = true;
        break;
      }
      if (!handled && declaredProviderId && directiveProvidersLocal.length > 0) {
        warnings.push(`unsupported ${declaredProviderId} directive key "${key}"`);
      }
    }
  }

  return {
    ttsText: overrides.ttsText,
    hasDirective: true,
    overrides,
    warnings,
  };
}

/** Parse TTS directives from final message text, leaving markdown code spans unchanged. */
export function parseTtsDirectives(
  text: string,
  policy: SpeechModelOverridePolicy,
  options?: ParseTtsDirectiveOptions,
): TtsDirectiveParseResult {
  if (!policy.enabled) {
    return { cleanedText: text, overrides: {}, warnings: [], hasDirective: false };
  }
  const extracted = extractTtsDirectiveFacts(text);
  const resolved = resolveTtsDirectiveFacts(extracted.facts, policy, options);

  return {
    cleanedText: extracted.cleanedText,
    ...resolved,
  };
}
