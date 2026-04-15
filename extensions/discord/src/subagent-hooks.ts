import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import {
  autoBindSpawnedDiscordSubagent,
  listThreadBindingsBySessionKey,
  type ThreadBindingTargetKind,
  unbindThreadBindingsBySessionKey,
} from "./monitor/thread-bindings.js";

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

type DiscordSubagentSpawningEvent = {
  threadRequested?: boolean;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  childSessionKey: string;
  agentId: string;
  label?: string;
};

type DiscordSubagentEndedEvent = {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
  reason?: string;
  sendFarewell?: boolean;
};

type DiscordSubagentDeliveryTargetEvent = {
  expectsCompletionMessage?: boolean;
  childSessionKey: string;
  requesterOrigin?: {
    channel?: string;
    accountId?: string;
    threadId?: string | number;
  };
};

type DiscordSubagentSpawningResult =
  | { status: "ok"; threadBindingReady?: boolean }
  | { status: "error"; error: string }
  | undefined;

type DiscordSubagentDeliveryTargetResult =
  | {
      origin: {
        channel: "discord";
        accountId?: string;
        to: string;
        threadId?: string | number;
      };
    }
  | undefined;

function normalizeThreadBindingTargetKind(raw?: string): ThreadBindingTargetKind | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (normalized === "subagent" || normalized === "acp") {
    return normalized;
  }
  return undefined;
}

function resolveThreadBindingFlags(api: OpenClawPluginApi, accountId?: string) {
  const account = resolveDiscordAccount({
    cfg: api.config,
    accountId,
  });
  const baseThreadBindings = api.config.channels?.discord?.threadBindings;
  const accountThreadBindings =
    api.config.channels?.discord?.accounts?.[account.accountId]?.threadBindings;
  return {
    enabled:
      accountThreadBindings?.enabled ??
      baseThreadBindings?.enabled ??
      api.config.session?.threadBindings?.enabled ??
      true,
    spawnSubagentSessions:
      accountThreadBindings?.spawnSubagentSessions ??
      baseThreadBindings?.spawnSubagentSessions ??
      false,
  };
}

export async function handleDiscordSubagentSpawning(
  api: OpenClawPluginApi,
  event: DiscordSubagentSpawningEvent,
): Promise<DiscordSubagentSpawningResult> {
  if (!event.threadRequested) {
    return undefined;
  }
  const channel = normalizeOptionalLowercaseString(event.requester?.channel);
  if (channel !== "discord") {
    return undefined;
  }
  const threadBindingFlags = resolveThreadBindingFlags(api, event.requester?.accountId);
  if (!threadBindingFlags.enabled) {
    return {
      status: "error" as const,
      error:
        "Discord thread bindings are disabled (set channels.discord.threadBindings.enabled=true to override for this account, or session.threadBindings.enabled=true globally).",
    };
  }
  if (!threadBindingFlags.spawnSubagentSessions) {
    return {
      status: "error" as const,
      error:
        "Discord thread-bound subagent spawns are disabled for this account (set channels.discord.threadBindings.spawnSubagentSessions=true to enable).",
    };
  }
  try {
    const agentId = event.agentId?.trim() || "subagent";
    const binding = await autoBindSpawnedDiscordSubagent({
      accountId: event.requester?.accountId,
      channel: event.requester?.channel,
      to: event.requester?.to,
      threadId: event.requester?.threadId,
      childSessionKey: event.childSessionKey,
      agentId,
      label: event.label,
      boundBy: "system",
    });
    if (!binding) {
      return {
        status: "error" as const,
        error:
          "Unable to create or bind a Discord thread for this subagent session. Session mode is unavailable for this target.",
      };
    }
    return { status: "ok" as const, threadBindingReady: true };
  } catch (err) {
    return {
      status: "error" as const,
      error: `Discord thread bind failed: ${summarizeError(err)}`,
    };
  }
}

export function handleDiscordSubagentEnded(event: DiscordSubagentEndedEvent) {
  unbindThreadBindingsBySessionKey({
    targetSessionKey: event.targetSessionKey,
    accountId: event.accountId,
    targetKind: normalizeThreadBindingTargetKind(event.targetKind),
    reason: event.reason,
    sendFarewell: event.sendFarewell,
  });
}

export function handleDiscordSubagentDeliveryTarget(
  event: DiscordSubagentDeliveryTargetEvent,
): DiscordSubagentDeliveryTargetResult {
  if (!event.expectsCompletionMessage) {
    return undefined;
  }
  const requesterChannel = normalizeOptionalLowercaseString(event.requesterOrigin?.channel);
  if (requesterChannel !== "discord") {
    return undefined;
  }
  const requesterAccountId = event.requesterOrigin?.accountId?.trim();
  const requesterThreadId =
    event.requesterOrigin?.threadId != null && event.requesterOrigin.threadId !== ""
      ? (normalizeOptionalStringifiedId(event.requesterOrigin.threadId) ?? "")
      : "";
  const bindings = listThreadBindingsBySessionKey({
    targetSessionKey: event.childSessionKey,
    ...(requesterAccountId ? { accountId: requesterAccountId } : {}),
    targetKind: "subagent",
  });
  if (bindings.length === 0) {
    return undefined;
  }

  let binding: (typeof bindings)[number] | undefined;
  if (requesterThreadId) {
    binding = bindings.find((entry) => {
      if (entry.threadId !== requesterThreadId) {
        return false;
      }
      if (requesterAccountId && entry.accountId !== requesterAccountId) {
        return false;
      }
      return true;
    });
  }
  if (!binding && bindings.length === 1) {
    binding = bindings[0];
  }
  if (!binding) {
    return undefined;
  }
  return {
    origin: {
      channel: "discord" as const,
      accountId: binding.accountId,
      to: `channel:${binding.threadId}`,
      threadId: binding.threadId,
    },
  };
}

export function registerDiscordSubagentHooks(api: OpenClawPluginApi) {
  api.on("subagent_spawning", (event) => handleDiscordSubagentSpawning(api, event));
  api.on("subagent_ended", (event) => handleDiscordSubagentEnded(event));
  api.on("subagent_delivery_target", (event) => handleDiscordSubagentDeliveryTarget(event));
}
