import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";

const DEFAULT_AGENT_ID = "main";

function normalizeAgentId(value: string | undefined | null): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "");
  return normalized || DEFAULT_AGENT_ID;
}

function normalizeChannelId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resolveDefaultAgentId(cfg: OpenClawConfig): string {
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const chosen = (agents.find((agent) => agent?.default) ?? agents[0])?.id;
  return normalizeAgentId(chosen);
}

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  for (const key of Object.keys(cfg.channels?.telegram?.accounts ?? {})) {
    if (key) {
      ids.add(normalizeAccountId(key));
    }
  }
  return [...ids];
}

function resolveBindingAccount(params: {
  binding: unknown;
  channelId: string;
}): { agentId: string; accountId: string } | null {
  if (!params.binding || typeof params.binding !== "object") {
    return null;
  }
  const binding = params.binding as {
    agentId?: unknown;
    match?: { channel?: unknown; accountId?: unknown };
  };
  if (normalizeChannelId(binding.match?.channel) !== params.channelId) {
    return null;
  }
  const accountId = typeof binding.match?.accountId === "string" ? binding.match.accountId : "";
  if (!accountId.trim() || accountId.trim() === "*") {
    return null;
  }
  return {
    agentId: normalizeAgentId(typeof binding.agentId === "string" ? binding.agentId : undefined),
    accountId: normalizeAccountId(accountId),
  };
}

function listBoundAccountIds(cfg: OpenClawConfig, channelId: string): string[] {
  const ids = new Set<string>();
  for (const binding of cfg.bindings ?? []) {
    const resolved = resolveBindingAccount({ binding, channelId });
    if (resolved) {
      ids.add(resolved.accountId);
    }
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}

function resolveDefaultAgentBoundAccountId(cfg: OpenClawConfig, channelId: string): string | null {
  const defaultAgentId = resolveDefaultAgentId(cfg);
  for (const binding of cfg.bindings ?? []) {
    const resolved = resolveBindingAccount({ binding, channelId });
    if (resolved?.agentId === defaultAgentId) {
      return resolved.accountId;
    }
  }
  return null;
}

function combineAccountIds(params: {
  configuredAccountIds: readonly string[];
  additionalAccountIds: readonly string[];
}): string[] {
  const ids = new Set<string>();
  for (const id of [...params.configuredAccountIds, ...params.additionalAccountIds]) {
    ids.add(normalizeAccountId(id));
  }
  if (ids.size === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}

function resolveListedDefaultAccountId(params: {
  accountIds: readonly string[];
  configuredDefaultAccountId: string | null | undefined;
}): string {
  const configured = normalizeOptionalAccountId(params.configuredDefaultAccountId);
  if (configured && params.accountIds.includes(configured)) {
    return configured;
  }
  if (params.accountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return params.accountIds[0] ?? DEFAULT_ACCOUNT_ID;
}

export function listTelegramAccountIds(cfg: OpenClawConfig): string[] {
  return combineAccountIds({
    configuredAccountIds: listConfiguredAccountIds(cfg),
    additionalAccountIds: listBoundAccountIds(cfg, "telegram"),
  });
}

export function resolveDefaultTelegramAccountSelection(cfg: OpenClawConfig): {
  accountId: string;
  accountIds: string[];
  shouldWarnMissingDefault: boolean;
} {
  const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "telegram");
  if (boundDefault) {
    return {
      accountId: boundDefault,
      accountIds: listTelegramAccountIds(cfg),
      shouldWarnMissingDefault: false,
    };
  }
  const accountIds = listTelegramAccountIds(cfg);
  const resolved = resolveListedDefaultAccountId({
    accountIds,
    configuredDefaultAccountId: cfg.channels?.telegram?.defaultAccount,
  });
  return {
    accountId: resolved,
    accountIds,
    shouldWarnMissingDefault:
      resolved === accountIds[0] &&
      !accountIds.includes(DEFAULT_ACCOUNT_ID) &&
      accountIds.length > 1,
  };
}

export function resolveDefaultTelegramAccountId(cfg: OpenClawConfig): string {
  return resolveDefaultTelegramAccountSelection(cfg).accountId;
}
