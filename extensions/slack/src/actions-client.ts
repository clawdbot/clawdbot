// Slack action client construction, split from actions.ts so sibling action
// modules (actions-canvas.ts and future splits) can import getClient without
// forming a runtime value cycle through actions.ts's own re-exports.
import type { WebClient } from "@slack/web-api";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveSlackAccount } from "./accounts.js";
import { createSlackLookupClient, getSlackWriteClient } from "./client.js";
import { assertSlackDetachedTargetAllowed } from "./detached-target-admission.js";
import { resolveSlackBotToken } from "./token.js";

export type SlackActionClientOpts = {
  cfg?: OpenClawConfig;
  accountId?: string;
  token?: string;
  teamId?: string;
  client?: WebClient;
};

export function resolveToken(explicit?: string, accountId?: string, cfg?: OpenClawConfig): string {
  if (explicit?.trim()) {
    const token = resolveSlackBotToken(explicit);
    if (token) {
      return token;
    }
  }
  if (!cfg) {
    throw new Error(
      "Slack actions requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const resolvedCfg = requireRuntimeConfig(cfg, "Slack actions");
  const account = resolveSlackAccount({ cfg: resolvedCfg, accountId });
  const token = resolveSlackBotToken(account.botToken ?? undefined);
  if (!token) {
    logVerbose(
      `slack actions: missing bot token for account=${account.accountId} explicit=${Boolean(
        explicit,
      )} source=${account.botTokenSource ?? "unknown"}`,
    );
    throw new Error("SLACK_BOT_TOKEN or channels.slack.botToken is required for Slack actions");
  }
  return token;
}

export async function getClient(opts: SlackActionClientOpts = {}, mode: "read" | "write" = "read") {
  if (opts.client) {
    return opts.client;
  }
  const accountId = opts.cfg
    ? resolveSlackAccount({
        cfg: requireRuntimeConfig(opts.cfg, "Slack actions"),
        accountId: opts.accountId,
      }).accountId
    : normalizeAccountId(opts.accountId);
  assertSlackDetachedTargetAllowed(accountId, opts.teamId);
  const token = resolveToken(opts.token, opts.accountId, opts.cfg);
  if (mode === "write") {
    return getSlackWriteClient(token, { teamId: opts.teamId });
  }
  return createSlackLookupClient(token, { teamId: opts.teamId });
}
