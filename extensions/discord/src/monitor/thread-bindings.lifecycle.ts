import { readAcpSessionEntry, type AcpSessionStoreEntry } from "openclaw/plugin-sdk/acp-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { parseDiscordTarget } from "../targets.js";
import { resolveChannelIdForBinding } from "./thread-bindings.discord-api.js";
import { getThreadBindingManager } from "./thread-bindings.manager.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "./thread-bindings.messages.js";
import { resolveBindingIdsForTargetSession } from "./thread-bindings.session-shared.js";
export {
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingMaxAgeBySessionKey,
} from "./thread-bindings.session-updates.js";
import {
  BINDINGS_BY_THREAD_ID,
  MANAGERS_BY_ACCOUNT_ID,
  getThreadBindingToken,
  normalizeThreadId,
  rememberRecentUnboundWebhookEcho,
  removeBindingRecord,
  saveBindingsToDisk,
  shouldPersistBindingMutations,
} from "./thread-bindings.state.js";
import type { ThreadBindingRecord, ThreadBindingTargetKind } from "./thread-bindings.types.js";

export type AcpThreadBindingReconciliationResult = {
  checked: number;
  removed: number;
  staleSessionKeys: string[];
};

export type AcpThreadBindingHealthStatus = "healthy" | "stale" | "uncertain";

export type AcpThreadBindingHealthProbe = (params: {
  cfg: OpenClawConfig;
  accountId: string;
  sessionKey: string;
  binding: ThreadBindingRecord;
  session: AcpSessionStoreEntry;
}) => Promise<{
  status: AcpThreadBindingHealthStatus;
  reason?: string;
}>;

// Cap startup fan-out so large binding sets do not create unbounded ACP probe spikes.
const ACP_STARTUP_HEALTH_PROBE_CONCURRENCY_LIMIT = 8;

async function mapWithConcurrency<TItem, TResult>(params: {
  items: TItem[];
  limit: number;
  worker: (item: TItem, index: number) => Promise<TResult>;
}): Promise<TResult[]> {
  if (params.items.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.floor(params.limit));
  const resultsByIndex = new Map<number, TResult>();
  let nextIndex = 0;

  const runWorker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= params.items.length) {
        return;
      }
      resultsByIndex.set(index, await params.worker(params.items[index], index));
    }
  };

  const workers = Array.from({ length: Math.min(limit, params.items.length) }, () => runWorker());
  await Promise.all(workers);
  return params.items.map((_item, index) => resultsByIndex.get(index)!);
}

export function listThreadBindingsForAccount(accountId?: string): ThreadBindingRecord[] {
  const manager = getThreadBindingManager(accountId);
  if (!manager) {
    return [];
  }
  return manager.listBindings();
}

export function listThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
}): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  return ids
    .map((bindingKey) => BINDINGS_BY_THREAD_ID.get(bindingKey))
    .filter((entry): entry is ThreadBindingRecord => Boolean(entry));
}

export async function autoBindSpawnedDiscordSubagent(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  channel?: string;
  to?: string;
  threadId?: string | number;
  childSessionKey: string;
  agentId: string;
  label?: string;
  boundBy?: string;
}): Promise<ThreadBindingRecord | null> {
  const channel = normalizeOptionalLowercaseString(params.channel);
  if (channel !== "discord") {
    return null;
  }
  const manager = getThreadBindingManager(params.accountId);
  if (!manager) {
    return null;
  }
  const managerToken = getThreadBindingToken(manager.accountId);

  const requesterThreadId = normalizeThreadId(params.threadId);
  let channelId = "";
  if (requesterThreadId) {
    const existing = manager.getByThreadId(requesterThreadId);
    if (existing?.channelId?.trim()) {
      channelId = existing.channelId.trim();
    } else {
      channelId =
        (await resolveChannelIdForBinding({
          cfg: params.cfg,
          accountId: manager.accountId,
          token: managerToken,
          threadId: requesterThreadId,
        })) ?? "";
    }
  }
  if (!channelId) {
    const to = normalizeOptionalString(params.to) ?? "";
    if (!to) {
      return null;
    }
    try {
      const target = parseDiscordTarget(to, { defaultKind: "channel" });
      if (!target || target.kind !== "channel") {
        return null;
      }
      channelId =
        (await resolveChannelIdForBinding({
          cfg: params.cfg,
          accountId: manager.accountId,
          token: managerToken,
          threadId: target.id,
        })) ?? "";
    } catch {
      return null;
    }
  }

  return await manager.bindTarget({
    threadId: undefined,
    channelId,
    createThread: true,
    threadName: resolveThreadBindingThreadName({
      agentId: params.agentId,
      label: params.label,
    }),
    targetKind: "subagent",
    targetSessionKey: params.childSessionKey,
    agentId: params.agentId,
    label: params.label,
    boundBy: params.boundBy ?? "system",
    introText: resolveThreadBindingIntroText({
      agentId: params.agentId,
      label: params.label,
      idleTimeoutMs: manager.getIdleTimeoutMs(),
      maxAgeMs: manager.getMaxAgeMs(),
    }),
  });
}

export function unbindThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
  reason?: string;
  sendFarewell?: boolean;
  farewellText?: string;
}): ThreadBindingRecord[] {
  const ids = resolveBindingIdsForTargetSession(params);
  if (ids.length === 0) {
    return [];
  }

  const removed: ThreadBindingRecord[] = [];
  for (const bindingKey of ids) {
    const record = BINDINGS_BY_THREAD_ID.get(bindingKey);
    if (!record) {
      continue;
    }
    const manager = MANAGERS_BY_ACCOUNT_ID.get(record.accountId);
    if (manager) {
      const unbound = manager.unbindThread({
        threadId: record.threadId,
        reason: params.reason,
        sendFarewell: params.sendFarewell,
        farewellText: params.farewellText,
      });
      if (unbound) {
        removed.push(unbound);
      }
      continue;
    }
    const unbound = removeBindingRecord(bindingKey);
    if (unbound) {
      rememberRecentUnboundWebhookEcho(unbound);
      removed.push(unbound);
    }
  }

  if (removed.length > 0 && shouldPersistBindingMutations()) {
    saveBindingsToDisk({ force: true });
  }
  return removed;
}

function resolveStoredAcpBindingHealth(params: {
  session: AcpSessionStoreEntry;
}): AcpThreadBindingHealthStatus {
  if (!params.session.acp) {
    return "stale";
  }
  return "healthy";
}

export async function reconcileAcpThreadBindingsOnStartup(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  sendFarewell?: boolean;
  healthProbe?: AcpThreadBindingHealthProbe;
}): Promise<AcpThreadBindingReconciliationResult> {
  const manager = getThreadBindingManager(params.accountId);
  if (!manager) {
    return {
      checked: 0,
      removed: 0,
      staleSessionKeys: [],
    };
  }

  const acpBindings = manager
    .listBindings()
    .filter(
      (binding) =>
        binding.targetKind === "acp" && binding.metadata?.pluginBindingOwner !== "plugin",
    );
  const staleBindings: ThreadBindingRecord[] = [];
  const probeTargets: Array<{
    binding: ThreadBindingRecord;
    sessionKey: string;
    session: AcpSessionStoreEntry;
  }> = [];

  for (const binding of acpBindings) {
    const sessionKey = binding.targetSessionKey.trim();
    if (!sessionKey) {
      staleBindings.push(binding);
      continue;
    }
    const session = readAcpSessionEntry({
      cfg: params.cfg,
      sessionKey,
    });
    if (!session) {
      staleBindings.push(binding);
      continue;
    }
    // Session store read failures are transient; never auto-unbind on uncertain reads.
    if (session.storeReadFailed) {
      continue;
    }

    if (resolveStoredAcpBindingHealth({ session }) === "stale") {
      staleBindings.push(binding);
      continue;
    }

    if (!params.healthProbe) {
      continue;
    }
    probeTargets.push({ binding, sessionKey, session });
  }

  if (params.healthProbe && probeTargets.length > 0) {
    const probeResults = await mapWithConcurrency({
      items: probeTargets,
      limit: ACP_STARTUP_HEALTH_PROBE_CONCURRENCY_LIMIT,
      worker: async ({ binding, sessionKey, session }) => {
        try {
          const result = await params.healthProbe?.({
            cfg: params.cfg,
            accountId: manager.accountId,
            sessionKey,
            binding,
            session,
          });
          return {
            binding,
            status: result?.status ?? ("uncertain" satisfies AcpThreadBindingHealthStatus),
          };
        } catch {
          // Treat probe failures as uncertain and keep the binding.
          return {
            binding,
            status: "uncertain" satisfies AcpThreadBindingHealthStatus,
          };
        }
      },
    });

    for (const probeResult of probeResults) {
      if (probeResult.status === "stale") {
        staleBindings.push(probeResult.binding);
      }
    }
  }

  if (staleBindings.length === 0) {
    return {
      checked: acpBindings.length,
      removed: 0,
      staleSessionKeys: [],
    };
  }

  const staleSessionKeys: string[] = [];
  let removed = 0;
  for (const binding of staleBindings) {
    staleSessionKeys.push(binding.targetSessionKey);
    const unbound = manager.unbindThread({
      threadId: binding.threadId,
      reason: "stale-session",
      sendFarewell: params.sendFarewell ?? false,
    });
    if (unbound) {
      removed += 1;
    }
  }

  return {
    checked: acpBindings.length,
    removed,
    staleSessionKeys: [...new Set(staleSessionKeys)],
  };
}
