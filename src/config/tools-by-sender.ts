import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { createDedupeCache } from "../infra/dedupe.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import {
  parseToolsBySenderTypedKey,
  type GroupToolPolicyBySenderConfig,
  type GroupToolPolicyConfig,
  type ToolsBySenderKeyType,
} from "./types.tools.js";

export type GroupToolPolicySender = {
  /** Skip sender-specific overlays for trusted non-ingress executions. */
  senderPolicyMode?: "always" | "never";
  messageProvider?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

type SenderKeyType = ToolsBySenderKeyType;
type CompiledSenderPolicy = {
  buckets: SenderPolicyBuckets;
  wildcard?: GroupToolPolicyConfig;
};

const MAX_WARNED_LEGACY_TOOLS_BY_SENDER_KEYS = 4096;
// Warning state spans fresh config snapshots; bounding it means evicted legacy keys can re-warn.
const warnedLegacyToolsBySenderKeys = createDedupeCache({
  ttlMs: 0,
  maxSize: MAX_WARNED_LEGACY_TOOLS_BY_SENDER_KEYS,
});
const compiledToolsBySenderCache = new WeakMap<
  GroupToolPolicyBySenderConfig,
  CompiledSenderPolicy
>();

type ParsedSenderPolicyKey =
  | { kind: "wildcard" }
  | { kind: "typed"; type: SenderKeyType; key: string };

type SenderPolicyBuckets = Record<ToolsBySenderKeyType, Map<string, GroupToolPolicyConfig>>;

function normalizeSenderKey(
  value: string,
  options: {
    stripLeadingAt?: boolean;
  } = {},
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutAt = options.stripLeadingAt && trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return normalizeLowercaseStringOrEmpty(withoutAt);
}

function normalizeTypedSenderKey(value: string, type: SenderKeyType): string {
  if (type === "channel") {
    return normalizeChannelSenderKey(value);
  }
  return normalizeSenderKey(value, {
    stripLeadingAt: type === "username",
  });
}

function normalizeSenderPolicyChannel(value: string | null | undefined): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return "";
  }
  return normalizeMessageChannel(trimmed) ?? normalizeSenderKey(trimmed);
}

function normalizeChannelSenderKey(value: string): string {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    return "";
  }
  const channel = normalizeSenderPolicyChannel(trimmed.slice(0, separatorIndex));
  const senderId = normalizeTypedSenderKey(trimmed.slice(separatorIndex + 1), "id");
  if (!channel || !senderId) {
    return "";
  }
  return `${channel}:${senderId}`;
}

function normalizeLegacySenderKey(value: string): string {
  return normalizeSenderKey(value, {
    stripLeadingAt: true,
  });
}

function warnLegacyToolsBySenderKey(rawKey: string) {
  const trimmed = rawKey.trim();
  if (!trimmed || warnedLegacyToolsBySenderKeys.check(trimmed)) {
    return;
  }
  process.emitWarning(
    `toolsBySender key "${trimmed}" is deprecated. Use explicit prefixes (channel:, id:, e164:, username:, name:). Legacy unprefixed keys are matched as id only.`,
    {
      type: "DeprecationWarning",
      code: "OPENCLAW_TOOLS_BY_SENDER_UNTYPED_KEY",
    },
  );
}

function parseSenderPolicyKey(rawKey: string): ParsedSenderPolicyKey | undefined {
  const trimmed = rawKey.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "*") {
    return { kind: "wildcard" };
  }
  const typed = parseToolsBySenderTypedKey(trimmed);
  if (typed) {
    const key = normalizeTypedSenderKey(typed.value, typed.type);
    if (!key) {
      return undefined;
    }
    return {
      kind: "typed",
      type: typed.type,
      key,
    };
  }

  // Backward-compatible fallback: untyped keys now map to immutable sender IDs only.
  warnLegacyToolsBySenderKey(trimmed);
  const key = normalizeLegacySenderKey(trimmed);
  if (!key) {
    return undefined;
  }
  return {
    kind: "typed",
    type: "id",
    key,
  };
}

function createSenderPolicyBuckets(): SenderPolicyBuckets {
  return {
    channel: new Map<string, GroupToolPolicyConfig>(),
    id: new Map<string, GroupToolPolicyConfig>(),
    e164: new Map<string, GroupToolPolicyConfig>(),
    username: new Map<string, GroupToolPolicyConfig>(),
    name: new Map<string, GroupToolPolicyConfig>(),
  };
}

function compileToolsBySenderPolicy(
  toolsBySender: GroupToolPolicyBySenderConfig,
): CompiledSenderPolicy | undefined {
  const entries = Object.entries(toolsBySender);
  if (entries.length === 0) {
    return undefined;
  }

  const buckets = createSenderPolicyBuckets();
  let wildcard: GroupToolPolicyConfig | undefined;
  for (const [rawKey, policy] of entries) {
    if (!policy) {
      continue;
    }
    const parsed = parseSenderPolicyKey(rawKey);
    if (!parsed) {
      continue;
    }
    if (parsed.kind === "wildcard") {
      wildcard = policy;
      continue;
    }
    const bucket = buckets[parsed.type];
    if (!bucket.has(parsed.key)) {
      bucket.set(parsed.key, policy);
    }
  }

  return { buckets, wildcard };
}

function resolveCompiledToolsBySenderPolicy(
  toolsBySender: GroupToolPolicyBySenderConfig,
): CompiledSenderPolicy | undefined {
  const cached = compiledToolsBySenderCache.get(toolsBySender);
  if (cached) {
    return cached;
  }
  const compiled = compileToolsBySenderPolicy(toolsBySender);
  if (!compiled) {
    return undefined;
  }
  // Config is loaded once and treated as immutable; cache compiled sender policy by object identity.
  compiledToolsBySenderCache.set(toolsBySender, compiled);
  return compiled;
}

function normalizeCandidate(value: string | null | undefined, type: SenderKeyType): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return "";
  }
  return normalizeTypedSenderKey(trimmed, type);
}

function normalizeSenderIdCandidates(value: string | null | undefined): string[] {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return [];
  }
  const typed = normalizeTypedSenderKey(trimmed, "id");
  const legacy = normalizeLegacySenderKey(trimmed);
  if (!typed) {
    return legacy ? [legacy] : [];
  }
  if (!legacy || legacy === typed) {
    return [typed];
  }
  return [typed, legacy];
}

function matchToolsBySenderPolicy(
  compiled: CompiledSenderPolicy,
  params: GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
  const senderIdCandidates = normalizeSenderIdCandidates(params.senderId);
  const channel = normalizeSenderPolicyChannel(params.messageProvider);
  if (channel) {
    for (const senderIdCandidate of senderIdCandidates) {
      const match = compiled.buckets.channel.get(`${channel}:${senderIdCandidate}`);
      if (match) {
        return match;
      }
    }
  }
  for (const senderIdCandidate of senderIdCandidates) {
    const match = compiled.buckets.id.get(senderIdCandidate);
    if (match) {
      return match;
    }
  }
  const senderE164 = normalizeCandidate(params.senderE164, "e164");
  if (senderE164) {
    const match = compiled.buckets.e164.get(senderE164);
    if (match) {
      return match;
    }
  }
  const senderUsername = normalizeCandidate(params.senderUsername, "username");
  if (senderUsername) {
    const match = compiled.buckets.username.get(senderUsername);
    if (match) {
      return match;
    }
  }
  const senderName = normalizeCandidate(params.senderName, "name");
  if (senderName) {
    const match = compiled.buckets.name.get(senderName);
    if (match) {
      return match;
    }
  }
  return compiled.wildcard;
}

export function resolveToolsBySender(
  params: {
    toolsBySender?: GroupToolPolicyBySenderConfig;
  } & GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
  const toolsBySender = params.toolsBySender;
  if (!toolsBySender) {
    return undefined;
  }
  const compiled = resolveCompiledToolsBySenderPolicy(toolsBySender);
  if (!compiled) {
    return undefined;
  }
  return matchToolsBySenderPolicy(compiled, params);
}
