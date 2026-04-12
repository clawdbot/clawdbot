import {
  buildConfiguredAcpSessionKey,
  normalizeBindingConfig,
  type ConfiguredAcpBindingChannel,
} from "../../acp/persistent-bindings.types.js";
import { resolveConfiguredBindingRecord } from "../../channels/plugins/binding-registry.js";
import { listAcpBindings } from "../../config/bindings.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { DEFAULT_ACCOUNT_ID, isAcpSessionKey } from "../../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

const acpResetTargetDeps = {
  getSessionBindingService,
  listAcpBindings,
  resolveConfiguredBindingRecord,
};

export const __testing = {
  setDepsForTest(
    overrides?: Partial<{
      getSessionBindingService: typeof getSessionBindingService;
      listAcpBindings: typeof listAcpBindings;
      resolveConfiguredBindingRecord: typeof resolveConfiguredBindingRecord;
    }>,
  ) {
    acpResetTargetDeps.getSessionBindingService =
      overrides?.getSessionBindingService ?? getSessionBindingService;
    acpResetTargetDeps.listAcpBindings = overrides?.listAcpBindings ?? listAcpBindings;
    acpResetTargetDeps.resolveConfiguredBindingRecord =
      overrides?.resolveConfiguredBindingRecord ?? resolveConfiguredBindingRecord;
  },
};

function resolveResetTargetAccountId(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
}): string {
  const explicit = normalizeOptionalString(params.accountId) ?? "";
  if (explicit) {
    return explicit;
  }

  const channelCfg = (
    params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined>
  )[params.channel];
  const configuredDefault = channelCfg?.defaultAccount;
  return normalizeOptionalString(configuredDefault) ?? DEFAULT_ACCOUNT_ID;
}

function resolveRawConfiguredAcpSessionKey(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): string | undefined {
  for (const binding of acpResetTargetDeps.listAcpBindings(params.cfg)) {
    const bindingChannel = normalizeLowercaseStringOrEmpty(
      normalizeOptionalString(binding.match.channel),
    );
    if (!bindingChannel || bindingChannel !== params.channel) {
      continue;
    }

    const bindingAccountId = normalizeOptionalString(binding.match.accountId) ?? "";
    if (bindingAccountId && bindingAccountId !== "*" && bindingAccountId !== params.accountId) {
      continue;
    }

    const peerId = normalizeOptionalString(binding.match.peer?.id) ?? "";
    const matchedConversationId =
      peerId === params.conversationId
        ? params.conversationId
        : peerId && peerId === params.parentConversationId
          ? params.parentConversationId
          : undefined;
    if (!matchedConversationId) {
      continue;
    }

    const acp = normalizeBindingConfig(binding.acp);
    return buildConfiguredAcpSessionKey({
      channel: params.channel as ConfiguredAcpBindingChannel,
      accountId: bindingAccountId && bindingAccountId !== "*" ? bindingAccountId : params.accountId,
      conversationId: matchedConversationId,
      ...(params.parentConversationId ? { parentConversationId: params.parentConversationId } : {}),
      agentId: binding.agentId,
      mode: acp.mode === "oneshot" ? "oneshot" : "persistent",
      ...(acp.cwd ? { cwd: acp.cwd } : {}),
      ...(acp.backend ? { backend: acp.backend } : {}),
      ...(acp.label ? { label: acp.label } : {}),
    });
  }

  return undefined;
}

export function resolveEffectiveResetTargetSessionKey(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  conversationId?: string | null;
  parentConversationId?: string | null;
  activeSessionKey?: string | null;
  allowNonAcpBindingSessionKey?: boolean;
  skipConfiguredFallbackWhenActiveSessionNonAcp?: boolean;
  fallbackToActiveAcpWhenUnbound?: boolean;
}): string | undefined {
  const activeSessionKey = normalizeOptionalString(params.activeSessionKey);
  const activeAcpSessionKey =
    activeSessionKey && isAcpSessionKey(activeSessionKey) ? activeSessionKey : undefined;
  const activeIsNonAcp = Boolean(activeSessionKey) && !activeAcpSessionKey;

  const channel = normalizeLowercaseStringOrEmpty(normalizeOptionalString(params.channel));
  const conversationId = normalizeOptionalString(params.conversationId) ?? "";
  if (!channel || !conversationId) {
    return activeAcpSessionKey;
  }
  const accountId = resolveResetTargetAccountId({
    cfg: params.cfg,
    channel,
    accountId: params.accountId,
  });
  const parentConversationId = normalizeOptionalString(params.parentConversationId) || undefined;
  const allowNonAcpBindingSessionKey = Boolean(params.allowNonAcpBindingSessionKey);

  const serviceBinding = acpResetTargetDeps.getSessionBindingService().resolveByConversation({
    channel,
    accountId,
    conversationId,
    parentConversationId,
  });
  const serviceSessionKey =
    serviceBinding?.targetKind === "session" ? serviceBinding.targetSessionKey.trim() : "";
  if (serviceSessionKey) {
    if (allowNonAcpBindingSessionKey) {
      return serviceSessionKey;
    }
    return isAcpSessionKey(serviceSessionKey) ? serviceSessionKey : undefined;
  }

  if (activeIsNonAcp && params.skipConfiguredFallbackWhenActiveSessionNonAcp) {
    return undefined;
  }

  const configuredBinding = acpResetTargetDeps.resolveConfiguredBindingRecord({
    cfg: params.cfg,
    channel,
    accountId,
    conversationId,
    parentConversationId,
  });
  const configuredSessionKey =
    configuredBinding?.record.targetKind === "session"
      ? configuredBinding.record.targetSessionKey.trim()
      : "";
  if (configuredSessionKey) {
    if (allowNonAcpBindingSessionKey) {
      return configuredSessionKey;
    }
    return isAcpSessionKey(configuredSessionKey) ? configuredSessionKey : undefined;
  }

  const rawConfiguredSessionKey = resolveRawConfiguredAcpSessionKey({
    cfg: params.cfg,
    channel,
    accountId,
    conversationId,
    ...(parentConversationId ? { parentConversationId } : {}),
  });
  if (rawConfiguredSessionKey) {
    return rawConfiguredSessionKey;
  }

  if (params.fallbackToActiveAcpWhenUnbound === false) {
    return undefined;
  }
  return activeAcpSessionKey;
}
