// Gateway RPC handlers for DM sender access requests on pairing-policy channels.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ChannelsPairingApproveParams,
  type ChannelsPairingApproveResult,
  type ChannelsPairingDismissParams,
  type ChannelsPairingListParams,
  type ChannelsPairingRequest,
  validateChannelsPairingApproveParams,
  validateChannelsPairingDismissParams,
  validateChannelsPairingListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveChannelDmPolicy } from "../../channels/plugins/dm-access.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import { notifyPairingApproved } from "../../channels/plugins/pairing.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { hasConfiguredCommandOwners } from "../../commands/doctor-command-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { bootstrapCommandOwnerFromPairing } from "../../pairing/command-owner.js";
import {
  approveChannelPairingRequest,
  CHANNEL_PAIRING_PENDING_MAX,
  CHANNEL_PAIRING_PENDING_TTL_MS,
  dismissChannelPairingRequest,
  listChannelPairingRequests,
  resolveChannelPairingRequestId,
} from "../../pairing/pairing-store.js";
import { resolveGatewayPluginConfig } from "../runtime-plugin-config.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

type PairingAccount = {
  plugin: ChannelPlugin;
  accountId: string;
  accountLabel?: string;
};

class InvalidPairingTargetError extends Error {}

function normalizeFilter(value: string | undefined): string | undefined {
  return normalizeOptionalString(value)?.toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolvePairingPolicy(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
  account: unknown;
}): string | undefined {
  const securityPolicy = params.plugin.security?.resolveDmPolicy?.({
    cfg: params.cfg,
    accountId: params.accountId,
    account: params.account,
  })?.policy;
  if (securityPolicy) {
    return securityPolicy;
  }
  const account = asRecord(params.account);
  return resolveChannelDmPolicy({
    account,
    parent: asRecord(account?.config),
    defaultPolicy: "pairing",
  });
}

function resolvePairingAccountLabel(plugin: ChannelPlugin, account: unknown, cfg: OpenClawConfig) {
  const described = plugin.config.describeAccount?.(account, cfg);
  return (
    normalizeOptionalString(described?.name) ?? normalizeOptionalString(asRecord(account)?.name)
  );
}

async function listPairingAccounts(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
}): Promise<PairingAccount[]> {
  const requestedChannel = normalizeFilter(params.channel);
  const requestedAccount = normalizeFilter(params.accountId);
  const pairingPlugins = listChannelPlugins().filter((plugin) => plugin.pairing);
  if (requestedChannel && !pairingPlugins.some((plugin) => plugin.id === requestedChannel)) {
    throw new InvalidPairingTargetError(`unknown pairing channel: ${params.channel}`);
  }

  const accounts: PairingAccount[] = [];
  for (const plugin of pairingPlugins) {
    if (requestedChannel && plugin.id !== requestedChannel) {
      continue;
    }
    for (const accountId of plugin.config.listAccountIds(params.cfg)) {
      if (requestedAccount && accountId.toLowerCase() !== requestedAccount) {
        continue;
      }
      const account = plugin.config.resolveAccount(params.cfg, accountId);
      const configured = plugin.config.isConfigured
        ? await plugin.config.isConfigured(account, params.cfg)
        : asRecord(account)?.configured !== false;
      if (
        !configured ||
        resolvePairingPolicy({ plugin, cfg: params.cfg, accountId, account }) !== "pairing"
      ) {
        continue;
      }
      const accountLabel = resolvePairingAccountLabel(plugin, account, params.cfg);
      accounts.push({
        plugin,
        accountId,
        ...(accountLabel ? { accountLabel } : {}),
      });
    }
  }
  return accounts;
}

async function resolvePairingAccount(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
}): Promise<PairingAccount | null> {
  const accounts = await listPairingAccounts(params);
  return accounts.length === 1 ? (accounts[0] ?? null) : null;
}

function publicAccount(account: PairingAccount) {
  const adapter = account.plugin.pairing;
  if (!adapter) {
    throw new Error(`Channel ${account.plugin.id} does not support pairing`);
  }
  return {
    channel: account.plugin.id,
    channelLabel: account.plugin.meta.label,
    accountId: account.accountId,
    ...(account.accountLabel ? { accountLabel: account.accountLabel } : {}),
    notifySupported: Boolean(adapter.notifyApproval),
  };
}

function publicRequest(params: {
  account: PairingAccount;
  request: Awaited<ReturnType<typeof listChannelPairingRequests>>[number];
}): ChannelsPairingRequest {
  const adapter = params.account.plugin.pairing;
  if (!adapter) {
    throw new Error(`Channel ${params.account.plugin.id} does not support pairing`);
  }
  const metadata = params.request.meta
    ? Object.fromEntries(
        Object.entries(params.request.meta).filter(([key, value]) => key !== "accountId" && value),
      )
    : undefined;
  const createdAtMs = Date.parse(params.request.createdAt);
  return {
    requestId: resolveChannelPairingRequestId(params.account.plugin.id, params.request),
    channel: params.account.plugin.id,
    channelLabel: params.account.plugin.meta.label,
    accountId: params.account.accountId,
    ...(params.account.accountLabel ? { accountLabel: params.account.accountLabel } : {}),
    senderId: params.request.id,
    senderLabel: adapter.idLabel,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    createdAt: params.request.createdAt,
    lastSeenAt: params.request.lastSeenAt,
    expiresAt: new Date(createdAtMs + CHANNEL_PAIRING_PENDING_TTL_MS).toISOString(),
    notifySupported: Boolean(adapter.notifyApproval),
  };
}

function invalidPairingAccount(respond: RespondFn, channel: string, accountId: string): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `channel account does not use DM pairing: ${channel}:${accountId}`,
    ),
  );
}

function respondPairingFailure(respond: RespondFn, error: unknown): void {
  respond(
    false,
    undefined,
    errorShape(
      error instanceof InvalidPairingTargetError
        ? ErrorCodes.INVALID_REQUEST
        : ErrorCodes.UNAVAILABLE,
      formatForLog(error),
    ),
  );
}

export const channelPairingHandlers: GatewayRequestHandlers = {
  "channels.pairing.list": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateChannelsPairingListParams,
        "channels.pairing.list",
        respond,
      )
    ) {
      return;
    }
    try {
      const parsed = params as ChannelsPairingListParams;
      const cfg = resolveGatewayPluginConfig({ config: context.getRuntimeConfig() });
      const accounts = await listPairingAccounts({
        cfg,
        ...(parsed.channel ? { channel: parsed.channel } : {}),
        ...(parsed.accountId ? { accountId: parsed.accountId } : {}),
      });
      const requests: ChannelsPairingRequest[] = [];
      for (const account of accounts) {
        const pending = await listChannelPairingRequests(
          account.plugin.id,
          process.env,
          account.accountId,
        );
        requests.push(...pending.map((request) => publicRequest({ account, request })));
      }
      respond(
        true,
        {
          accounts: accounts.map(publicAccount),
          requests,
          commandOwnerConfigured: hasConfiguredCommandOwners(cfg),
          limits: {
            pendingPerAccount: CHANNEL_PAIRING_PENDING_MAX,
            ttlMs: CHANNEL_PAIRING_PENDING_TTL_MS,
          },
        },
        undefined,
      );
    } catch (error) {
      respondPairingFailure(respond, error);
    }
  },

  "channels.pairing.approve": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateChannelsPairingApproveParams,
        "channels.pairing.approve",
        respond,
      )
    ) {
      return;
    }
    const parsed = params as ChannelsPairingApproveParams;
    let cfg: OpenClawConfig;
    let account: PairingAccount | null;
    try {
      cfg = resolveGatewayPluginConfig({ config: context.getRuntimeConfig() });
      account = await resolvePairingAccount({
        cfg,
        channel: parsed.channel,
        accountId: parsed.accountId,
      });
    } catch (error) {
      respondPairingFailure(respond, error);
      return;
    }
    if (!account?.plugin.pairing) {
      invalidPairingAccount(respond, parsed.channel, parsed.accountId);
      return;
    }
    try {
      const approved = await approveChannelPairingRequest({
        channel: account.plugin.id,
        accountId: account.accountId,
        requestId: parsed.requestId,
        pairingAdapter: account.plugin.pairing,
      });
      if (!approved) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "pending DM access request no longer exists"),
        );
        return;
      }

      let commandOwnerBootstrap: ChannelsPairingApproveResult["commandOwnerBootstrap"] =
        "not-requested";
      if (parsed.bootstrapCommandOwner === true) {
        try {
          commandOwnerBootstrap = (
            await bootstrapCommandOwnerFromPairing({
              channel: account.plugin.id,
              id: approved.id,
            })
          ).status;
        } catch (error) {
          context.logGateway.warn(
            `DM pairing command-owner bootstrap failed channel=${account.plugin.id} account=${account.accountId}: ${formatForLog(error)}`,
          );
          commandOwnerBootstrap = "unavailable";
        }
      }

      let notification: "not-requested" | "sent" | "unsupported" | "failed" = "not-requested";
      if (parsed.notify === true) {
        if (!account.plugin.pairing.notifyApproval) {
          notification = "unsupported";
        } else {
          try {
            await notifyPairingApproved({
              channelId: account.plugin.id,
              accountId: account.accountId,
              id: approved.id,
              cfg,
              pairingAdapter: account.plugin.pairing,
            });
            notification = "sent";
          } catch (error) {
            context.logGateway.warn(
              `DM pairing approval notification failed channel=${account.plugin.id} account=${account.accountId}: ${formatForLog(error)}`,
            );
            notification = "failed";
          }
        }
      }

      respond(
        true,
        {
          requestId: parsed.requestId,
          senderId: approved.id,
          notification,
          commandOwnerBootstrap,
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    }
  },

  "channels.pairing.dismiss": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateChannelsPairingDismissParams,
        "channels.pairing.dismiss",
        respond,
      )
    ) {
      return;
    }
    const parsed = params as ChannelsPairingDismissParams;
    let account: PairingAccount | null;
    try {
      const cfg = resolveGatewayPluginConfig({ config: context.getRuntimeConfig() });
      account = await resolvePairingAccount({
        cfg,
        channel: parsed.channel,
        accountId: parsed.accountId,
      });
    } catch (error) {
      respondPairingFailure(respond, error);
      return;
    }
    if (!account) {
      invalidPairingAccount(respond, parsed.channel, parsed.accountId);
      return;
    }
    try {
      const dismissed = await dismissChannelPairingRequest({
        channel: account.plugin.id,
        accountId: account.accountId,
        requestId: parsed.requestId,
      });
      if (!dismissed) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "pending DM access request no longer exists"),
        );
        return;
      }
      respond(true, { requestId: parsed.requestId, senderId: dismissed.id }, undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error)));
    }
  },
};
