// Signal alias helpers keep OpenClaw-side names inside the Signal plugin boundary.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelDirectoryEntry } from "openclaw/plugin-sdk/core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./normalize.js";

type SignalResolvedTargetKind = "user" | "group";

type ResolvedSignalAliasTarget = {
  to: string;
  kind: SignalResolvedTargetKind;
  alias: string;
};

type ResolvedSignalTarget =
  | (ResolvedSignalAliasTarget & { source: "alias" })
  | {
      to: string;
      kind: SignalResolvedTargetKind;
      source: "raw";
    };

function normalizeAliasKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutSignal = /^signal:/i.test(trimmed)
    ? trimmed.slice("signal:".length).trim()
    : trimmed;
  const normalized = normalizeLowercaseStringOrEmpty(withoutSignal);
  return normalized || undefined;
}

function resolveAliasMap(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Map<string, string> {
  const account = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const aliases = new Map<string, string>();
  for (const [rawKey, rawValue] of Object.entries(account.config.aliases ?? {})) {
    const key = normalizeAliasKey(rawKey);
    if (!key) {
      continue;
    }
    aliases.set(key, rawValue);
  }
  return aliases;
}

function resolveTargetKind(target: string): SignalResolvedTargetKind {
  return normalizeLowercaseStringOrEmpty(target).startsWith("group:") ? "group" : "user";
}

function resolveRawSignalTarget(
  input: string,
): { to: string; kind: SignalResolvedTargetKind } | null {
  const normalized = normalizeSignalMessagingTarget(input);
  if (!normalized || !looksLikeSignalTargetId(input, normalized)) {
    return null;
  }
  return {
    to: normalized,
    kind: resolveTargetKind(normalized),
  };
}

function resolveSignalAliasTargetFromMap(params: {
  aliases: ReadonlyMap<string, string>;
  input: string;
}): ResolvedSignalAliasTarget | null {
  const initialAlias = normalizeAliasKey(params.input);
  if (!initialAlias || !params.aliases.has(initialAlias)) {
    return null;
  }

  const visited = new Set<string>();
  let alias = initialAlias;
  for (;;) {
    if (visited.has(alias)) {
      throw new Error(`Signal alias "${initialAlias}" resolves recursively through "${alias}".`);
    }
    visited.add(alias);

    const rawValue = params.aliases.get(alias);
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      throw new Error(`Signal alias "${alias}" must point to a non-empty Signal target.`);
    }

    const rawTarget = resolveRawSignalTarget(rawValue);
    if (rawTarget) {
      return {
        ...rawTarget,
        alias: initialAlias,
      };
    }

    const nextAlias = normalizeAliasKey(rawValue);
    if (nextAlias && params.aliases.has(nextAlias)) {
      alias = nextAlias;
      continue;
    }

    throw new Error(
      `Signal alias "${initialAlias}" must point to an E.164 number, uuid:<id>, username:<name>, or group:<id>.`,
    );
  }
}

function resolveSignalAliasTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  input: string;
}): ResolvedSignalAliasTarget | null {
  const aliases = resolveAliasMap(params);
  return resolveSignalAliasTargetFromMap({
    aliases,
    input: params.input,
  });
}

export function resolveSignalTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  input: string;
}): ResolvedSignalTarget | null {
  const rawTarget = resolveRawSignalTarget(params.input);
  if (rawTarget) {
    return {
      ...rawTarget,
      source: "raw",
    };
  }
  const aliasTarget = resolveSignalAliasTarget(params);
  if (aliasTarget) {
    return { ...aliasTarget, source: "alias" };
  }
  return null;
}

export function listSignalAliasDirectoryEntries(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  kind: SignalResolvedTargetKind;
  query?: string | null;
  limit?: number | null;
}): ChannelDirectoryEntry[] {
  const aliases = resolveAliasMap(params);
  const query = normalizeLowercaseStringOrEmpty(params.query);
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : undefined;
  const exactAlias = params.query ? normalizeAliasKey(params.query) : undefined;
  if (exactAlias && aliases.has(exactAlias)) {
    const target = resolveSignalAliasTargetFromMap({ aliases, input: exactAlias });
    if (target?.kind === params.kind) {
      return [{ kind: params.kind, id: target.to, name: target.alias }];
    }
    if (target) {
      return [];
    }
  }
  const entries: ChannelDirectoryEntry[] = [];
  for (const alias of aliases.keys()) {
    let target: ResolvedSignalAliasTarget | null;
    try {
      target = resolveSignalAliasTargetFromMap({ aliases, input: alias });
    } catch {
      continue;
    }
    if (!target) {
      continue;
    }
    if (target.kind !== params.kind) {
      continue;
    }
    if (
      query &&
      !alias.includes(query) &&
      !normalizeLowercaseStringOrEmpty(target.to).includes(query)
    ) {
      continue;
    }
    entries.push({ kind: params.kind, id: target.to, name: alias });
    if (typeof limit === "number" && entries.length >= limit) {
      break;
    }
  }
  return entries;
}
