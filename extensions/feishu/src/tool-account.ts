import type * as Lark from "@larksuiteoapi/node-sdk";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawPluginApi } from "../runtime-api.js";
import {
  listFeishuAccountIds,
  resolveFeishuAccount,
  resolveFeishuRuntimeAccount,
} from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { resolveToolsConfig } from "./tools-config.js";
import type { FeishuToolsConfig, ResolvedFeishuAccount } from "./types.js";

type AccountAwareParams = { accountId?: string };

function resolveImplicitToolAccountId(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
}): string | undefined {
  const explicitAccountId = normalizeOptionalString(params.executeParams?.accountId);
  if (explicitAccountId) {
    return explicitAccountId;
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
  if (configuredDefaultAccountId) {
    return configuredDefaultAccountId;
  }

  return undefined;
}

export function resolveFeishuToolAccount(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
}): ResolvedFeishuAccount {
  if (!params.api.config) {
    throw new Error("Feishu config unavailable");
  }
  return resolveFeishuRuntimeAccount({
    cfg: params.api.config,
    accountId: resolveImplicitToolAccountId(params),
  });
}

export function createFeishuToolClient(params: {
  api: Pick<OpenClawPluginApi, "config">;
  executeParams?: AccountAwareParams;
  defaultAccountId?: string;
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
  };
  for (const account of accounts) {
    const cfg = resolveToolsConfig(account.config.tools);
    merged.doc = merged.doc || cfg.doc;
    merged.chat = merged.chat || cfg.chat;
    merged.wiki = merged.wiki || cfg.wiki;
    merged.drive = merged.drive || cfg.drive;
    merged.perm = merged.perm || cfg.perm;
    merged.scopes = merged.scopes || cfg.scopes;
  }
  return merged;
}
