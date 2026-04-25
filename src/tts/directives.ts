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

type TextRange = {
  start: number;
  end: number;
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

function collectMarkdownCodeRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  const addMatches = (regex: RegExp) => {
    for (const match of text.matchAll(regex)) {
      if (match.index == null) {
        continue;
      }
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  };

  addMatches(/```[\s\S]*?```/g);
  addMatches(/~~~[\s\S]*?~~~/g);
  addMatches(/^(?: {4}|\t).*(?:\n|$)/gm);
  addMatches(/`+[^`\n]*`+/g);

  return ranges.toSorted((left, right) => left.start - right.start);
}

function isInsideRange(index: number, ranges: readonly TextRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function replaceOutsideMarkdownCode(
  text: string,
  regex: RegExp,
  replace: (match: string, captures: readonly string[]) => string,
): string {
  const codeRanges = collectMarkdownCodeRanges(text);
  return text.replace(regex, (...args: unknown[]) => {
    const match = String(args[0]);
    const offset = args.at(-2);
    if (typeof offset === "number" && isInsideRange(offset, codeRanges)) {
      return match;
    }
    const captures = args.slice(1, -2).map((capture) => String(capture));
    return replace(match, captures);
  });
}

export function parseTtsDirectives(
  text: string,
  policy: SpeechModelOverridePolicy,
  options?: ParseTtsDirectiveOptions,
): TtsDirectiveParseResult {
  if (!policy.enabled) {
    return { cleanedText: text, overrides: {}, warnings: [], hasDirective: false };
  }

  if (!/\[\[\s*\/?\s*tts(?:\s*:|\s*\]\])/iu.test(text)) {
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

  const blockRegex = /\[\[\s*tts\s*:\s*text\s*\]\]([\s\S]*?)\[\[\s*\/\s*tts\s*:\s*text\s*\]\]/gi;
  cleanedText = replaceOutsideMarkdownCode(cleanedText, blockRegex, (_match, [inner = ""]) => {
    hasDirective = true;
    if (policy.allowText && overrides.ttsText == null) {
      overrides.ttsText = inner.trim();
    }
    return "";
  });

  const plainBlockRegex = /\[\[\s*tts\s*\]\]([\s\S]*?)\[\[\s*\/\s*tts\s*\]\]/gi;
  cleanedText = replaceOutsideMarkdownCode(cleanedText, plainBlockRegex, (_match, [inner = ""]) => {
    hasDirective = true;
    const visible = inner.trim();
    if (policy.allowText && overrides.ttsText == null) {
      overrides.ttsText = visible;
    }
    return visible;
  });

  const directiveRegex = /\[\[\s*tts\s*:\s*([^\]]+)\]\]/gi;
  cleanedText = replaceOutsideMarkdownCode(cleanedText, directiveRegex, (_match, [body = ""]) => {
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

  const bareTagRegex = /\[\[\s*tts\s*\]\]/gi;
  cleanedText = replaceOutsideMarkdownCode(cleanedText, bareTagRegex, () => {
    hasDirective = true;
    return "";
  });

  const closingTagRegex = /\[\[\s*\/\s*tts(?:\s*:\s*[^\]]*)?\]\]/gi;
  cleanedText = replaceOutsideMarkdownCode(cleanedText, closingTagRegex, () => {
    hasDirective = true;
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
