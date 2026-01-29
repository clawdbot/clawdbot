import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { ModelRef } from "../../agents/model-selection.js";
import { parseModelRef } from "../../agents/model-selection.js";

export type Intent = "chat" | "strategy" | "code" | "summarize" | "tool" | "continuity";

export type RouteDecision = {
  intent: Intent;
  provider: string;
  model: string;
  reason: string;
  isDefault: boolean;
  fallbacks?: ModelRef[];
};

type IntentRoutingSpec = {
  primary?: string;
  fallbacks?: string[];
};

type RouterRoutingConfig = {
  intents?: Partial<Record<Intent, IntentRoutingSpec>>;
};

type RouterPolicyConfig = {
  complexity?: {
    contextTokensGe?: number;
    target?: string;
  };
  guardrails?: {
    highStakes?: boolean;
  };
};

export type RouterConfig = {
  routing?: RouterRoutingConfig;
  policy?: RouterPolicyConfig;
  limitsRaw?: string;
  pricingRaw?: string;
};

const INTENTS: Intent[] = ["chat", "strategy", "code", "summarize", "tool", "continuity"];

const DEFAULT_INTENT_ROUTES: Partial<
  Record<Intent, { primary: ModelRef; fallbacks?: ModelRef[] }>
> = {
  chat: {
    primary: { provider: "anthropic", model: "haiku" },
    fallbacks: [{ provider: "anthropic", model: "sonnet" }],
  },
  strategy: {
    primary: { provider: "anthropic", model: "sonnet" },
    fallbacks: [{ provider: "anthropic", model: "haiku" }],
  },
  code: {
    primary: { provider: "openai-codex", model: "codex" },
  },
  summarize: {
    primary: { provider: "anthropic", model: "haiku" },
  },
  continuity: {
    primary: { provider: "local", model: "local_small" },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return null;
    throw error;
  }
}

function parseRoutingConfig(raw: string): RouterRoutingConfig {
  const parsed = YAML.parse(raw) as unknown;
  if (!isRecord(parsed)) return {};
  const intentsRaw = isRecord(parsed.intents) ? parsed.intents : undefined;
  if (!intentsRaw) return {};

  const intents: Partial<Record<Intent, IntentRoutingSpec>> = {};
  for (const intent of INTENTS) {
    const entry = intentsRaw[intent];
    if (!isRecord(entry)) continue;
    const primary = toOptionalString(entry.primary);
    const fallbacks = toStringArray(entry.fallbacks);
    if (!primary && !fallbacks) continue;
    intents[intent] = {
      ...(primary ? { primary } : {}),
      ...(fallbacks ? { fallbacks } : {}),
    };
  }
  return { intents };
}

function parsePolicyConfig(raw: string): RouterPolicyConfig {
  const parsed = YAML.parse(raw) as unknown;
  if (!isRecord(parsed)) return {};
  const complexityRaw = isRecord(parsed.complexity) ? parsed.complexity : undefined;
  const guardrailsRaw = isRecord(parsed.guardrails) ? parsed.guardrails : undefined;

  const contextTokensGe = (() => {
    const value =
      complexityRaw?.context_tokens_ge ??
      complexityRaw?.contextTokensGe ??
      complexityRaw?.threshold;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  })();

  const target = toOptionalString(complexityRaw?.target);
  const highStakes = (() => {
    const value = guardrailsRaw?.high_stakes ?? guardrailsRaw?.highStakes;
    return typeof value === "boolean" ? value : undefined;
  })();

  const hasComplexity = contextTokensGe !== undefined || target !== undefined;
  return {
    ...(hasComplexity
      ? {
          complexity: {
            ...(contextTokensGe !== undefined ? { contextTokensGe } : {}),
            ...(target ? { target } : {}),
          },
        }
      : {}),
    ...(highStakes !== undefined ? { guardrails: { highStakes } } : {}),
  };
}

function parseModelRefOrNull(raw: string | undefined, defaultProvider: string): ModelRef | null {
  if (!raw) return null;
  return parseModelRef(raw, defaultProvider);
}

function resolveFallbackRefs(
  fallbacks: string[] | undefined,
  defaultProvider: string,
): ModelRef[] | undefined {
  if (!fallbacks) return undefined;
  const parsed = fallbacks
    .map((entry) => parseModelRef(entry, defaultProvider))
    .filter((entry): entry is ModelRef => !!entry);
  return parsed.length > 0 ? parsed : [];
}

export async function loadRouterConfig(dir: string): Promise<RouterConfig | null> {
  const [routingRaw, limitsRaw, pricingRaw, policyRaw] = await Promise.all([
    readOptionalFile(path.join(dir, "routing.yaml")),
    readOptionalFile(path.join(dir, "limits.yaml")),
    readOptionalFile(path.join(dir, "pricing.yaml")),
    readOptionalFile(path.join(dir, "policy.yaml")),
  ]);

  if (!routingRaw && !limitsRaw && !pricingRaw && !policyRaw) return null;

  return {
    ...(routingRaw ? { routing: parseRoutingConfig(routingRaw) } : {}),
    ...(policyRaw ? { policy: parsePolicyConfig(policyRaw) } : {}),
    ...(limitsRaw ? { limitsRaw } : {}),
    ...(pricingRaw ? { pricingRaw } : {}),
  };
}

export function resolveRouteDecision(params: {
  cfg: RouterConfig | null;
  agentDir?: string;
  intent: Intent;
  defaultModelRef: ModelRef;
  contextTokens?: number;
  highStakes?: boolean;
}): RouteDecision {
  const { cfg, intent, defaultModelRef, contextTokens } = params;
  if (!cfg) {
    return {
      intent,
      provider: defaultModelRef.provider,
      model: defaultModelRef.model,
      reason: "default",
      isDefault: true,
    };
  }

  const baseRoute = DEFAULT_INTENT_ROUTES[intent];
  let primary = baseRoute?.primary ?? defaultModelRef;
  let fallbacks = baseRoute?.fallbacks;
  const defaultProvider = defaultModelRef.provider;

  const intentRouting = cfg.routing?.intents?.[intent];
  const overridePrimary = parseModelRefOrNull(intentRouting?.primary, defaultProvider);
  if (overridePrimary) {
    primary = overridePrimary;
  }

  if (intentRouting && "fallbacks" in intentRouting) {
    fallbacks = resolveFallbackRefs(intentRouting.fallbacks, defaultProvider) ?? fallbacks;
  }

  const shouldEscalate =
    (intent === "chat" || intent === "strategy") &&
    cfg.policy?.complexity?.contextTokensGe !== undefined &&
    contextTokens !== undefined &&
    contextTokens >= cfg.policy.complexity.contextTokensGe;

  if (shouldEscalate) {
    const target = parseModelRefOrNull(cfg.policy?.complexity?.target, defaultProvider) ?? {
      provider: "anthropic",
      model: "opus",
    };
    return {
      intent,
      provider: target.provider,
      model: target.model,
      reason: "complexity",
      isDefault: false,
      ...(fallbacks && fallbacks.length > 0 ? { fallbacks } : {}),
    };
  }

  return {
    intent,
    provider: primary.provider,
    model: primary.model,
    reason: "intent",
    isDefault: false,
    ...(fallbacks && fallbacks.length > 0 ? { fallbacks } : {}),
  };
}
