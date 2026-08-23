// Feishu plugin module implements tool account behavior.
import type * as Lark from "@larksuiteoapi/node-sdk";
import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-resolution";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";
import {
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
  resolveFeishuRuntimeAccount,
} from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";
import type { FeishuToolsConfig, ResolvedFeishuAccount } from "./types.js";

type AccountAwareParams = { accountId?: string };
type FeishuToolFamily = keyof FeishuToolsConfig;
type FeishuToolRequirement = {
  family: FeishuToolFamily;
  label: string;
};

function resolveImplicitToolAccountId(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
  requiredTool: FeishuToolRequirement;
}): string {
  const explicitAccountId = normalizeOptionalString(params.executeParams?.accountId);
  if (explicitAccountId) {
    const normalizedAccountId = normalizeOptionalAccountId(explicitAccountId);
    if (!normalizedAccountId) {
      throw new Error(`Invalid Feishu account ID "${explicitAccountId}"`);
    }
    const listedAccountId =
      listFeishuAccountIds(params.api.config).find(
        (accountId) => normalizeOptionalAccountId(accountId) === normalizedAccountId,
      ) ??
      (() => {
        const defaultAccountId = resolveDefaultFeishuAccountId(params.api.config);
        return normalizeOptionalAccountId(defaultAccountId) === normalizedAccountId
          ? defaultAccountId
          : undefined;
      })();
    if (!listedAccountId) {
      throw new Error(`Unknown Feishu account "${explicitAccountId}"`);
    }
    const account = resolveFeishuAccount({
      cfg: params.api.config,
      accountId: normalizedAccountId,
    });
    if (!account.enabled) {
      throw new Error(`Feishu account "${listedAccountId}" is disabled`);
    }
    return normalizedAccountId;
  }

  const contextualAccountId = normalizeOptionalString(params.defaultAccountId);
  if (
    contextualAccountId &&
    listFeishuAccountIds(params.api.config).includes(contextualAccountId)
  ) {
    const contextualAccount = resolveFeishuAccount({
      cfg: params.api.config,
      accountId: contextualAccountId,
    });
    if (contextualAccount.enabled) {
      return contextualAccountId;
    }
  }

  const configuredDefaultAccountId = normalizeOptionalString(
    (params.api.config?.channels?.feishu as { defaultAccount?: unknown } | undefined)
      ?.defaultAccount,
  );
  // A routing preference must not reactivate credentials that the operator disabled.
  if (
    configuredDefaultAccountId &&
    resolveFeishuAccount({ cfg: params.api.config, accountId: configuredDefaultAccountId }).enabled
  ) {
    return configuredDefaultAccountId;
  }

  if (params.api.config) {
    for (const accountId of listFeishuAccountIds(params.api.config)) {
      const account = resolveFeishuAccount({ cfg: params.api.config, accountId });
      if (
        account.enabled &&
        account.configured &&
        resolveToolsConfig(account.config.tools)[params.requiredTool.family]
      ) {
        return accountId;
      }
    }
  }

  throw new Error(`No usable Feishu account has ${params.requiredTool.label} tools enabled`);
}

export function resolveFeishuToolAccount(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
  requiredTool: FeishuToolRequirement;
}): ResolvedFeishuAccount {
  if (!params.api.config) {
    throw new Error("Feishu config unavailable");
  }
  const account = resolveFeishuRuntimeAccount({
    cfg: params.api.config,
    accountId: resolveImplicitToolAccountId(params),
  });
  if (!resolveToolsConfig(account.config.tools)[params.requiredTool.family]) {
    throw new Error(
      `Feishu ${params.requiredTool.label} tools are disabled for account "${account.accountId}"`,
    );
  }
  return account;
}

export function createFeishuToolClient(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
  requiredTool: FeishuToolRequirement;
}): Lark.Client {
  return createFeishuClient(resolveFeishuToolAccount(params));
}

export function resolveAnyEnabledFeishuToolsConfig(
  accounts: ResolvedFeishuAccount[],
): Required<FeishuToolsConfig> {
  const merged: Required<FeishuToolsConfig> = {
    doc: false,
    chat: false,
    wiki: false,
    drive: false,
    perm: false,
    scopes: false,
    bitable: false,
  };
  for (const account of accounts) {
    const cfg = resolveToolsConfig(account.config.tools);
    merged.doc = merged.doc || cfg.doc;
    merged.chat = merged.chat || cfg.chat;
    merged.wiki = merged.wiki || cfg.wiki;
    merged.drive = merged.drive || cfg.drive;
    merged.perm = merged.perm || cfg.perm;
    merged.scopes = merged.scopes || cfg.scopes;
    merged.bitable = merged.bitable || cfg.bitable;
  }
  return merged;
}
