import type { Model, OpenAICompletionsCompat } from "../types.js";

type OpenAICompletionsSessionAffinity = "none" | "openai" | "openrouter";

export type ResolvedOpenAICompletionsCompat = Omit<
  Required<OpenAICompletionsCompat>,
  "cacheControlFormat" | "openRouterRouting" | "sendSessionAffinityHeaders"
> & {
  cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
  openRouterRouting?: OpenAICompletionsCompat["openRouterRouting"];
  sessionAffinity: OpenAICompletionsSessionAffinity;
};

type DetectedOpenAICompletionsCompat = Omit<
  ResolvedOpenAICompletionsCompat,
  "openRouterRouting" | "sessionAffinity"
> & {
  sessionAffinityFormat: Exclude<OpenAICompletionsSessionAffinity, "none">;
};

type OpenAICompletionsCompatRule = {
  priority: number;
  providers?: readonly string[];
  baseUrlIncludes?: readonly string[];
  compat: Partial<DetectedOpenAICompletionsCompat>;
};

const DEFAULT_OPENAI_COMPLETIONS_COMPAT = {
  supportsStore: true,
  supportsDeveloperRole: true,
  supportsReasoningEffort: true,
  supportsUsageInStreaming: true,
  maxTokensField: "max_completion_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: "openai",
  vercelGatewayRouting: {},
  zaiToolStream: false,
  supportsStrictMode: true,
  cacheControlFormat: undefined,
  sessionAffinityFormat: "openai",
  supportsPromptCacheKey: false,
  supportsLongCacheRetention: true,
} satisfies DetectedOpenAICompletionsCompat;

const OPENAI_COMPLETIONS_COMPAT_MATRIX = {
  openrouter: {
    priority: 10,
    providers: ["openrouter"],
    baseUrlIncludes: ["openrouter.ai"],
    compat: {
      supportsDeveloperRole: false,
      thinkingFormat: "openrouter",
      sessionAffinityFormat: "openrouter",
    },
  },
  cerebras: {
    priority: 20,
    providers: ["cerebras"],
    baseUrlIncludes: ["cerebras.ai"],
    compat: { supportsStore: false, supportsDeveloperRole: false },
  },
  xai: {
    priority: 20,
    providers: ["xai"],
    baseUrlIncludes: ["api.x.ai"],
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  },
  moonshot: {
    priority: 20,
    providers: ["moonshotai", "moonshotai-cn"],
    baseUrlIncludes: ["api.moonshot."],
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
    },
  },
  cloudflareWorkersAi: {
    priority: 20,
    providers: ["cloudflare-workers-ai"],
    baseUrlIncludes: ["api.cloudflare.com"],
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsLongCacheRetention: false,
    },
  },
  cloudflareAiGateway: {
    priority: 20,
    providers: ["cloudflare-ai-gateway"],
    baseUrlIncludes: ["gateway.ai.cloudflare.com"],
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
    },
  },
  opencode: {
    priority: 20,
    providers: ["opencode"],
    baseUrlIncludes: ["opencode.ai"],
    compat: { supportsStore: false, supportsDeveloperRole: false },
  },
  chutes: {
    priority: 20,
    baseUrlIncludes: ["chutes.ai"],
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
    },
  },
  together: {
    priority: 30,
    providers: ["together"],
    baseUrlIncludes: ["api.together.ai", "api.together.xyz"],
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "together",
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
    },
  },
  zai: {
    priority: 40,
    providers: ["zai"],
    baseUrlIncludes: ["api.z.ai"],
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "zai",
    },
  },
  xiaomi: {
    priority: 50,
    providers: ["xiaomi"],
    baseUrlIncludes: ["xiaomimimo.com"],
    compat: {
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    },
  },
  deepseekProvider: {
    priority: 60,
    providers: ["deepseek"],
    compat: {
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    },
  },
  deepseekEndpoint: {
    priority: 60,
    baseUrlIncludes: ["deepseek.com"],
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    },
  },
} as const satisfies Record<string, OpenAICompletionsCompatRule>;

type OpenAICompletionsCompatProfile = keyof typeof OPENAI_COMPLETIONS_COMPAT_MATRIX;

type OpenAICompletionsModelCompatRule = {
  profile?: OpenAICompletionsCompatProfile;
  providers?: readonly string[];
  modelIdPrefixes: readonly string[];
  compat: Partial<DetectedOpenAICompletionsCompat>;
};

const OPENAI_COMPLETIONS_MODEL_COMPAT_MATRIX = [
  {
    profile: "openrouter",
    modelIdPrefixes: ["anthropic/", "openai/"],
    compat: { supportsDeveloperRole: true },
  },
  {
    providers: ["openrouter"],
    modelIdPrefixes: ["anthropic/"],
    compat: { cacheControlFormat: "anthropic" },
  },
] as const satisfies readonly OpenAICompletionsModelCompatRule[];

const SORTED_OPENAI_COMPLETIONS_COMPAT_RULES = Object.entries(
  OPENAI_COMPLETIONS_COMPAT_MATRIX,
).toSorted(([, left], [, right]) => left.priority - right.priority) as Array<
  [OpenAICompletionsCompatProfile, OpenAICompletionsCompatRule]
>;

function matchesCompatRule(
  model: Pick<Model<"openai-completions">, "provider" | "baseUrl">,
  rule: OpenAICompletionsCompatRule,
): boolean {
  return (
    rule.providers?.includes(model.provider) === true ||
    rule.baseUrlIncludes?.some((fragment) => model.baseUrl.includes(fragment)) === true
  );
}

function matchesModelCompatRule(
  model: Pick<Model<"openai-completions">, "provider" | "id">,
  matchedProfiles: ReadonlySet<OpenAICompletionsCompatProfile>,
  rule: OpenAICompletionsModelCompatRule,
): boolean {
  if (rule.profile !== undefined && !matchedProfiles.has(rule.profile)) {
    return false;
  }
  if (rule.providers !== undefined && !rule.providers.includes(model.provider)) {
    return false;
  }
  return rule.modelIdPrefixes.some((prefix) => model.id.startsWith(prefix));
}

/** Detects request compatibility from the provider, endpoint, and model family matrices. */
function detectOpenAICompletionsCompat(
  model: Pick<Model<"openai-completions">, "provider" | "baseUrl" | "id">,
): DetectedOpenAICompletionsCompat {
  const compat: DetectedOpenAICompletionsCompat = { ...DEFAULT_OPENAI_COMPLETIONS_COMPAT };
  const matchedProfiles = new Set<OpenAICompletionsCompatProfile>();

  for (const [profile, rule] of SORTED_OPENAI_COMPLETIONS_COMPAT_RULES) {
    if (!matchesCompatRule(model, rule)) {
      continue;
    }
    Object.assign(compat, rule.compat);
    matchedProfiles.add(profile);
  }

  for (const rule of OPENAI_COMPLETIONS_MODEL_COMPAT_MATRIX) {
    if (matchesModelCompatRule(model, matchedProfiles, rule)) {
      Object.assign(compat, rule.compat);
    }
  }

  return compat;
}

function resolveSessionAffinity(
  model: Pick<Model<"openai-completions">, "compat">,
  detectedFormat: DetectedOpenAICompletionsCompat["sessionAffinityFormat"],
): OpenAICompletionsSessionAffinity {
  if (model.compat?.sendSessionAffinityHeaders !== true) {
    return "none";
  }
  if (
    detectedFormat === "openrouter" ||
    model.compat.thinkingFormat === "openrouter" ||
    model.compat.openRouterRouting !== undefined
  ) {
    return "openrouter";
  }
  return "openai";
}

/** Applies explicit model overrides to the detected compatibility defaults. */
export function resolveOpenAICompletionsCompat(
  model: Model<"openai-completions">,
): ResolvedOpenAICompletionsCompat {
  const detected = detectOpenAICompletionsCompat(model);
  const configured = model.compat;

  return {
    supportsStore: configured?.supportsStore ?? detected.supportsStore,
    supportsDeveloperRole: configured?.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    supportsReasoningEffort:
      configured?.supportsReasoningEffort ?? detected.supportsReasoningEffort,
    supportsUsageInStreaming:
      configured?.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
    maxTokensField: configured?.maxTokensField ?? detected.maxTokensField,
    requiresToolResultName: configured?.requiresToolResultName ?? detected.requiresToolResultName,
    requiresAssistantAfterToolResult:
      configured?.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
    requiresThinkingAsText: configured?.requiresThinkingAsText ?? detected.requiresThinkingAsText,
    requiresReasoningContentOnAssistantMessages:
      configured?.requiresReasoningContentOnAssistantMessages ??
      detected.requiresReasoningContentOnAssistantMessages,
    thinkingFormat: configured?.thinkingFormat ?? detected.thinkingFormat,
    openRouterRouting: configured?.openRouterRouting,
    vercelGatewayRouting: configured?.vercelGatewayRouting ?? detected.vercelGatewayRouting,
    zaiToolStream: configured?.zaiToolStream ?? detected.zaiToolStream,
    supportsStrictMode: configured?.supportsStrictMode ?? detected.supportsStrictMode,
    cacheControlFormat: configured?.cacheControlFormat ?? detected.cacheControlFormat,
    sessionAffinity: resolveSessionAffinity(model, detected.sessionAffinityFormat),
    supportsPromptCacheKey: configured?.supportsPromptCacheKey ?? detected.supportsPromptCacheKey,
    supportsLongCacheRetention:
      configured?.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
  };
}
