import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import type { OpenClawConfig } from "../runtime-api.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isFeishuDocToolEnabled(cfg: OpenClawConfig): boolean {
  const channels = asRecord(cfg.channels);
  const feishu = asRecord(channels?.feishu);
  if (!feishu || feishu.enabled === false) {
    return false;
  }

  const baseTools = asRecord(feishu.tools);
  const baseDocEnabled = baseTools?.doc !== false;
  const baseAppId = hasNonEmptyString(feishu.appId);
  const baseAppSecret = hasConfiguredSecretInput(feishu.appSecret, cfg.secrets?.defaults);
  const baseConfigured = baseAppId && baseAppSecret;

  const accounts = asRecord(feishu.accounts);
  if (!accounts || Object.keys(accounts).length === 0) {
    return baseDocEnabled && baseConfigured;
  }

  for (const accountValue of Object.values(accounts)) {
    const account = asRecord(accountValue) ?? {};
    if (account.enabled === false) {
      continue;
    }
    const accountTools = asRecord(account.tools);
    const effectiveTools = accountTools ?? baseTools;
    const docEnabled = effectiveTools?.doc !== false;
    if (!docEnabled) {
      continue;
    }
    const accountConfigured =
      (hasNonEmptyString(account.appId) || baseAppId) &&
      (hasConfiguredSecretInput(account.appSecret, cfg.secrets?.defaults) || baseAppSecret);
    if (accountConfigured) {
      return true;
    }
  }

  return false;
}

export function collectFeishuSecurityAuditFindings(params: { cfg: OpenClawConfig }) {
  if (!isFeishuDocToolEnabled(params.cfg)) {
    return [];
  }
  return [
    {
      checkId: "channels.feishu.doc_owner_open_id",
      severity: "warn" as const,
      title: "Feishu doc create can grant requester permissions",
      detail:
        'channels.feishu tools include "doc"; feishu_doc action "create" can grant document access to the trusted requesting Feishu user.',
      remediation:
        "Disable channels.feishu.tools.doc when not needed, and restrict tool access for untrusted prompts.",
    },
  ];
}
