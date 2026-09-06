// TTS directive helpers parse inline speech directives from text.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import type { AssistantDeliveryTtsFacts } from "../llm/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { findCodeRegions, type CodeRegion } from "../shared/text/code-regions.js";
import { extractTtsDirectiveFacts, parseTtsDirectiveBody } from "./directive-facts.js";
import { compareSpeechProviderOrder } from "./provider-registry-core.js";
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

// TRANSITIONAL(marker-retirement): the [[tts ...]] text DSL is a transitional
// adapter for automatic-mode replies; structured voiceText/voiceProvider/voiceId
// fields are canonical. Delete the DSL parse forms and this streaming cleaner
// when the visibleReplies default flips to "message_tool".
/** Streaming cleaner used to strip TTS tags before final text parsing is available. */
type TtsDirectiveTextStreamCleaner = {
  /** Append token chunks without introducing a logical block boundary. */
  push: (text: string) => string;
  /** Append a reply block, preserving its boundary unless TTS syntax continues. */
  pushBlock: (text: string) => string;
  /** Finish the stream and emit any suffix awaiting final Markdown ownership. */
  flush: () => string;
  /** Resolve the accumulated speech source at the end of block delivery. */
  getSourceText: () => string;
  /** Original buffered bytes, without inferred block separators, for final coverage. */
  getPendingSourceText: () => string;
  /** Release text after another delivery path has accepted ownership of it. */
  clear: () => void;
};

function resolveDirectiveProviders(options?: ParseTtsDirectiveOptions): SpeechProviderPlugin[] {
  const providers = options?.providers ?? listSpeechProviders(options?.cfg);
  return providers.toSorted(compareSpeechProviderOrder);
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

function parseTtsTag(body: string) {
  if (/^\s*tts\s*:\s*text\s*$/i.test(body)) {
    return { kind: "hidden-open" } as const;
  }
  if (/^\s*\/\s*tts\s*:\s*text\s*$/i.test(body)) {
    return { kind: "hidden-close" } as const;
  }
  if (/^\s*tts\s*$/i.test(body) || /^\s*\/\s*tts(?:\s*:[\s\S]*)?$/i.test(body)) {
    return { kind: "marker" } as const;
  }
  const directiveBody = /^\s*tts\s*:([^\]]+)$/i.exec(body)?.[1];
  return directiveBody === undefined
    ? ({ kind: "literal" } as const)
    : parseTtsDirectiveBody(directiveBody);
}

function joinTtsBlocks(source: string, boundaries: number[]): string {
  // Logical blocks initially own a newline. TTS syntax may consume that boundary,
  // but literal examples inside canonical Markdown code must retain it.
  const joined = new Set<number>();
  for (;;) {
    const remaining = boundaries.filter((boundary) => !joined.has(boundary));
    if (remaining.length === 0) {
      return source;
    }
    const parts: string[] = [];
    let cursor = 0;
    for (const boundary of remaining) {
      parts.push(source.slice(cursor, boundary), "\n");
      cursor = boundary;
    }
    parts.push(source.slice(cursor));
    const text = parts.join("");
    const regions = findCodeRegions(text);
    const previouslyJoined = joined.size;
    let boundaryIndex = 0;
    let regionIndex = 0;
    let hidden = false;
    let tagCursor = 0;
    while (tagCursor < source.length) {
      const start = source.indexOf("[[", tagCursor);
      if (start === -1) {
        break;
      }
      const close = source.indexOf("]]", start + 2);
      if (close === -1) {
        break;
      }
      tagCursor = close + 2;
      let boundary = remaining[boundaryIndex];
      while (boundary !== undefined && boundary <= start) {
        if (hidden) {
          joined.add(boundary);
        }
        boundary = remaining[++boundaryIndex];
      }
      const offset = start + boundaryIndex;
      let region = regions[regionIndex];
      while (region && region.end <= offset) {
        region = regions[++regionIndex];
      }
      const insideCode = region !== undefined && region.start <= offset;
      const tag = parseTtsTag(source.slice(start + 2, close));
      const directive = !insideCode && tag.kind !== "literal";
      while (boundary !== undefined && boundary < tagCursor) {
        if (hidden || directive) {
          joined.add(boundary);
        }
        boundary = remaining[++boundaryIndex];
      }
      if (directive) {
        if (tag.kind === "hidden-open") {
          hidden = true;
        } else if (tag.kind === "hidden-close") {
          hidden = false;
        }
      }
    }
    if (hidden) {
      for (const boundary of remaining.slice(boundaryIndex)) {
        joined.add(boundary);
      }
    }
    if (joined.size === previouslyJoined) {
      return text;
    }
    // Removing an inferred newline can change later code ownership. Each repeat
    // removes at least one recorded boundary: at most B + 1 full Markdown parses
    // for B boundaries, with worst-case terminal work proportional to B times
    // the document parse cost. Token arrival never runs this normalization.
  }
}

/** Create an incremental cleaner for hiding [[tts:*]] directive text while streaming. */
export function createTtsDirectiveTextStreamCleaner(): TtsDirectiveTextStreamCleaner {
  const sourceChunks: string[] = [];
  const blockBoundaries: number[] = [];
  let sourceLength = 0;
  let resolvedSource: string | undefined;
  let consumed = 0;
  let markdownTail = "";
  let deferredSource = false;
  let pending: string[] = [];
  let pendingInsideCode = false;
  let insideHiddenTextBlock = false;

  const consume = (input: string, regions: CodeRegion[] = []): string => {
    const output: string[] = [];
    let regionIndex = 0;
    const emit = (text: string) => {
      if (!insideHiddenTextBlock) {
        output.push(text);
      }
    };

    for (let index = 0; index < input.length; index++) {
      const char = input.charAt(index);
      if (pending.length === 1 && char !== "[") {
        emit("[");
        pending = [];
      }
      if (pending.length === 0) {
        if (char !== "[") {
          emit(char);
          continue;
        }
        const offset = consumed + index;
        let region = regions[regionIndex];
        while (region && region.end <= offset) {
          regionIndex++;
          region = regions[regionIndex];
        }
        pendingInsideCode = region !== undefined && region.start <= offset;
      }
      pending.push(char);
      if (pending.length < 4 || char !== "]" || pending.at(-2) !== "]") {
        continue;
      }

      const rawTag = pending.join("");
      pending = [];
      if (pendingInsideCode) {
        emit(rawTag);
        continue;
      }
      const tag = parseTtsTag(rawTag.slice(2, -2));
      if (tag.kind === "hidden-open") {
        insideHiddenTextBlock = true;
      } else if (tag.kind === "hidden-close") {
        insideHiddenTextBlock = false;
      } else if (tag.kind === "literal") {
        emit(rawTag);
      } else if (tag.kind === "text") {
        emit(tag.text);
      }
    }
    consumed += input.length;
    return output.join("");
  };

  const push = (text: string): string => {
    sourceChunks.push(text);
    sourceLength += text.length;
    resolvedSource = undefined;
    if (!deferredSource) {
      // Code ownership can change with a later closing backtick or block line.
      // Resolve the buffered suffix only at termination, not on every chunk.
      deferredSource = /[`~\t]| {4}/u.test(markdownTail + text);
      markdownTail = (markdownTail + text).slice(-3);
    }
    return deferredSource ? "" : consume(text);
  };
  const getSourceText = () =>
    (resolvedSource ??= joinTtsBlocks(sourceChunks.join(""), blockBoundaries));

  return {
    push,
    pushBlock(text: string): string {
      if (sourceLength === 0 || !text) {
        return push(text);
      }
      if (pending.length > 0 && !deferredSource) {
        // An incomplete bracket may be ordinary text. Resolve its block boundary
        // with the complete syntax before deciding whether TTS consumes it.
        consumed -= pending.length;
        pending = [];
        deferredSource = true;
      }
      if (deferredSource) {
        blockBoundaries.push(sourceLength);
        return push(text);
      }
      if (!insideHiddenTextBlock) {
        // Separate payloads own their presentation boundary. Retain it only in
        // the complete source used to resolve Markdown and speech at termination.
        sourceChunks.push("\n");
        sourceLength++;
        consumed++;
        markdownTail = (markdownTail + "\n").slice(-3);
      }
      return push(text);
    },
    flush(): string {
      let output = "";
      if (consumed < sourceLength) {
        const source = getSourceText();
        output = consume(source.slice(consumed), findCodeRegions(source));
      }
      const tail = pending.join("");
      pending = [];
      return output + (insideHiddenTextBlock ? "" : tail);
    },
    getSourceText,
    getPendingSourceText: () => sourceChunks.join("").slice(consumed - pending.length),
    clear(): void {
      sourceChunks.length = 0;
      blockBoundaries.length = 0;
      sourceLength = 0;
      resolvedSource = undefined;
      consumed = 0;
      markdownTail = "";
      deferredSource = false;
      pending = [];
      pendingInsideCode = false;
      insideHiddenTextBlock = false;
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
