/**
 * INTERACTION_CREATE event handler.
 *
 * Handles three interaction branches:
 *
 * 1. **Config query**  (type=2001) — reads config, ACKs with `claw_cfg`.
 * 2. **Config update** (type=2002) — writes config, ACKs with updated snapshot.
 * 3. **Approval button** (other)   — ACKs, resolves approval via PlatformAdapter.
 *
 * Config query/update require `runtime.config`. When unavailable, those
 * branches fall through to a bare ACK (backward-compatible).
 */

import { resolveQQBotEffectivePolicies } from "../access/resolve-policy.js";
import { getPlatformAdapter } from "../adapter/index.js";
import { parseApprovalButtonData } from "../approval/index.js";
import { getPluginVersion, getFrameworkVersion } from "../commands/slash-commands-impl.js";
import { resolveGroupConfig, resolveMentionPatterns } from "../config/group.js";
import { resolveAccountBase } from "../config/resolve.js";
import type { GroupActivationMode } from "../group/activation.js";
import { accountToCreds, acknowledgeInteraction } from "../messaging/sender.js";
import type { InteractionEvent, QQBotAccountConfigView } from "../types.js";
import { InteractionType } from "./constants.js";
import type { GatewayAccount, GatewayPluginRuntime, EngineLogger } from "./types.js";

// ============ claw_cfg snapshot ============

/**
 * Build the canonical `claw_cfg` snapshot returned in interaction ACKs.
 *
 * Pure function — all resolution helpers live in engine/config/.
 */
function buildClawCfgSnapshot(
  cfg: Record<string, unknown>,
  accountId: string,
  groupOpenid: string,
  runtime: GatewayPluginRuntime,
): Record<string, unknown> {
  const groupCfg = groupOpenid ? resolveGroupConfig(cfg, groupOpenid, accountId) : null;
  const accountBase = resolveAccountBase(cfg, accountId);
  const acctCfg = accountBase.config as QQBotAccountConfigView;
  const policies = resolveQQBotEffectivePolicies({
    allowFrom: acctCfg.allowFrom,
    groupAllowFrom: acctCfg.groupAllowFrom,
    dmPolicy: acctCfg.dmPolicy,
    groupPolicy: acctCfg.groupPolicy,
  });

  const requireMentionMode: GroupActivationMode =
    (groupCfg?.requireMention ?? true) ? "mention" : "always";

  const interactionAgentId = groupOpenid
    ? (
        runtime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "qqbot",
          accountId,
          peer: { kind: "group", id: groupOpenid },
        }) as { agentId?: string } | undefined
      )?.agentId
    : undefined;

  return {
    channel_type: "qqbot",
    channel_ver: getPluginVersion(),
    claw_type: "openclaw",
    claw_ver: getFrameworkVersion(),
    require_mention: requireMentionMode,
    group_policy: policies.groupPolicy,
    mention_patterns: resolveMentionPatterns(cfg, interactionAgentId).join(","),
    online_state: "online",
  };
}

// ============ Config update ============

/** Apply a config-update interaction and return the updated claw_cfg. */
async function applyConfigUpdate(
  event: InteractionEvent,
  accountId: string,
  runtime: GatewayPluginRuntime,
  log?: EngineLogger,
): Promise<Record<string, unknown>> {
  const configApi = runtime.config;
  if (!configApi) {
    throw new Error("runtime.config not available");
  }

  const resolved = event.data?.resolved as Record<string, unknown> | undefined;
  const clawCfgUpdate = resolved?.claw_cfg as Record<string, unknown> | undefined;
  const groupOpenid = event.group_openid ?? "";

  const currentCfg = structuredClone(configApi.current());
  let changed = false;

  if (clawCfgUpdate?.require_mention !== undefined && groupOpenid) {
    applyRequireMentionUpdate(currentCfg, accountId, groupOpenid, clawCfgUpdate);
    changed = true;
  }

  if (changed) {
    await configApi.replaceConfigFile({ nextConfig: currentCfg, afterWrite: { mode: "auto" } });
    log?.info(
      `Config updated via interaction ${event.id}: require_mention=${String(clawCfgUpdate?.require_mention)}, group=${groupOpenid}`,
    );
  }

  const latestCfg = changed ? configApi.current() : currentCfg;
  return buildClawCfgSnapshot(latestCfg, accountId, groupOpenid, runtime);
}

/** Mutate `cfg` in place to apply a require_mention update for a group. */
function applyRequireMentionUpdate(
  cfg: Record<string, unknown>,
  accountId: string,
  groupOpenid: string,
  update: Record<string, unknown>,
): void {
  const requireMentionBool = update.require_mention === "mention";
  const channels = (cfg.channels ?? {}) as Record<string, unknown>;
  const qqbot = (channels.qqbot ?? {}) as Record<string, unknown>;

  const isNamedAccount =
    accountId !== "default" &&
    Boolean((qqbot.accounts as Record<string, Record<string, unknown>> | undefined)?.[accountId]);

  if (isNamedAccount) {
    const accounts = (qqbot.accounts ?? {}) as Record<string, Record<string, unknown>>;
    const acct = accounts[accountId] ?? {};
    const groups = (acct.groups ?? {}) as Record<string, Record<string, unknown>>;
    groups[groupOpenid] = { ...groups[groupOpenid], requireMention: requireMentionBool };
    acct.groups = groups;
    accounts[accountId] = acct;
    qqbot.accounts = accounts;
  } else {
    const groups = (qqbot.groups ?? {}) as Record<string, Record<string, unknown>>;
    groups[groupOpenid] = { ...groups[groupOpenid], requireMention: requireMentionBool };
    qqbot.groups = groups;
  }
}

// ============ Public factory ============

/**
 * Create the INTERACTION_CREATE event handler.
 *
 * Returns a fire-and-forget callback that `GatewayConnection` calls
 * on every `action: "interaction"` dispatch result.
 */
export function createInteractionHandler(
  account: GatewayAccount,
  runtime: GatewayPluginRuntime,
  log?: EngineLogger,
): (event: InteractionEvent) => void {
  return (event) => {
    const creds = accountToCreds(account);
    const type = event.data?.type;

    // ---- Config query (type=2001) ----
    if (type === InteractionType.CONFIG_QUERY && runtime.config) {
      void handleWithAck(creds, event, log, "CONFIG_QUERY", () => {
        const cfg = runtime.config!.current();
        return buildClawCfgSnapshot(cfg, account.accountId, event.group_openid ?? "", runtime);
      });
      return;
    }

    // ---- Config update (type=2002) ----
    if (type === InteractionType.CONFIG_UPDATE && runtime.config) {
      void handleWithAck(creds, event, log, "CONFIG_UPDATE", () =>
        applyConfigUpdate(event, account.accountId, runtime, log),
      );
      return;
    }

    // ---- Approval button / other ----
    void acknowledgeInteraction(creds, event.id).catch((err) => {
      log?.error(`Interaction ACK failed: ${err instanceof Error ? err.message : String(err)}`);
    });

    const parsed = parseApprovalButtonData(event.data?.resolved?.button_data ?? "");
    if (!parsed) {
      return;
    }

    const adapter = getPlatformAdapter();
    if (!adapter.resolveApproval) {
      log?.error("resolveApproval not available on PlatformAdapter");
      return;
    }

    void adapter.resolveApproval(parsed.approvalId, parsed.decision).then((ok) => {
      if (ok) {
        log?.info(`Approval resolved: id=${parsed.approvalId}, decision=${parsed.decision}`);
      } else {
        log?.error(`Approval resolve failed: id=${parsed.approvalId}`);
      }
    });
  };
}

// ============ Helpers ============

/** Execute an async handler, ACK with the result, and handle errors. */
async function handleWithAck(
  creds: { appId: string; clientSecret: string },
  event: InteractionEvent,
  log: EngineLogger | undefined,
  label: string,
  handler: () => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<void> {
  try {
    const clawCfg = await handler();
    await acknowledgeInteraction(creds, event.id, 0, { claw_cfg: clawCfg });
    log?.info(`Interaction ACK (${label}) sent: ${event.id}`);
  } catch (err) {
    log?.error(`${label} interaction failed: ${err instanceof Error ? err.message : String(err)}`);
    void acknowledgeInteraction(creds, event.id).catch(() => {});
  }
}
