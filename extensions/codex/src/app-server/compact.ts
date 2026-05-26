import {
  embeddedAgentLog,
  type CompactEmbeddedPiSessionParams,
  type EmbeddedPiCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  defaultCodexAppServerClientFactory,
  type CodexAppServerClientFactory,
} from "./client-factory.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type { JsonObject } from "./protocol.js";
import { resolveCodexNativeExecutionBlock } from "./sandbox-guard.js";
import { readCodexAppServerBinding } from "./session-binding.js";

const warnedIgnoredCompactionOverrides = new Set<string>();

export async function maybeCompactCodexAppServerSession(
  params: CompactEmbeddedPiSessionParams,
  options: { pluginConfig?: unknown; clientFactory?: CodexAppServerClientFactory } = {},
): Promise<EmbeddedPiCompactResult | undefined> {
  warnIfIgnoringOpenClawCompactionOverrides(params);
  // Codex owns automatic context-pressure compaction for Codex runtime sessions.
  // This entry point is only for explicit/manual compaction requests. OpenClaw
  // starts native Codex compaction for the bound thread and returns immediately;
  // Codex reports and applies the compaction inside its own app-server session.
  return compactCodexNativeThread(params, options);
}

function warnIfIgnoringOpenClawCompactionOverrides(params: CompactEmbeddedPiSessionParams): void {
  const ignoredConfig = readIgnoredCompactionOverridePaths(params);
  if (ignoredConfig.length === 0) {
    return;
  }
  const warningKey = ignoredConfig.join("\0");
  if (warnedIgnoredCompactionOverrides.has(warningKey)) {
    return;
  }
  warnedIgnoredCompactionOverrides.add(warningKey);
  embeddedAgentLog.warn(
    "ignoring OpenClaw compaction overrides for Codex app-server compaction; Codex uses native server-side compaction",
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      ignoredConfig,
    },
  );
}

function readIgnoredCompactionOverridePaths(params: CompactEmbeddedPiSessionParams): string[] {
  const ignored = new Set<string>();
  for (const entry of readCompactionOverrideEntries(params)) {
    const localProvider =
      typeof entry.record.provider === "string" ? entry.record.provider.trim() : "";
    const inheritedProvider =
      !localProvider && typeof entry.inheritedRecord?.provider === "string"
        ? entry.inheritedRecord.provider.trim()
        : "";
    const providerPath = localProvider
      ? `${entry.path}.compaction.provider`
      : inheritedProvider && entry.inheritedPath
        ? `${entry.inheritedPath}.compaction.provider`
        : undefined;
    if (typeof entry.record.model === "string" && entry.record.model.trim()) {
      ignored.add(`${entry.path}.compaction.model`);
    }
    if (providerPath) {
      ignored.add(providerPath);
    }
  }
  return [...ignored];
}

function readCompactionOverrideEntries(params: CompactEmbeddedPiSessionParams): Array<{
  path: string;
  record: Record<string, unknown>;
  inheritedRecord?: Record<string, unknown>;
  inheritedPath?: string;
}> {
  const entries: Array<{
    path: string;
    record: Record<string, unknown>;
    inheritedRecord?: Record<string, unknown>;
    inheritedPath?: string;
  }> = [];
  const defaultCompaction = readRecord(readRecord(params.config?.agents)?.defaults)?.compaction;
  const defaultRecord = readRecord(defaultCompaction);
  if (defaultRecord) {
    entries.push({ path: "agents.defaults", record: defaultRecord });
  }
  const agentId = readAgentIdFromSessionKey(params.sessionKey ?? params.sandboxSessionKey);
  if (!agentId) {
    return entries;
  }
  const agents = Array.isArray(params.config?.agents?.list) ? params.config.agents.list : [];
  const activeAgent = agents.find((agent) => {
    const id = typeof agent?.id === "string" ? agent.id.trim().toLowerCase() : "";
    return id === agentId;
  });
  const agentCompaction = readRecord(activeAgent)?.compaction;
  const agentRecord = readRecord(agentCompaction);
  if (agentRecord) {
    entries.push({
      path: `agents.list.${agentId}`,
      record: agentRecord,
      inheritedRecord: defaultRecord,
      inheritedPath: "agents.defaults",
    });
  }
  return entries;
}

function readAgentIdFromSessionKey(sessionKey: string | undefined): string | undefined {
  const parts = sessionKey?.trim().toLowerCase().split(":").filter(Boolean) ?? [];
  if (parts.length < 3 || parts[0] !== "agent") {
    return undefined;
  }
  return parts[1]?.trim() || undefined;
}

async function compactCodexNativeThread(
  params: CompactEmbeddedPiSessionParams,
  options: { pluginConfig?: unknown; clientFactory?: CodexAppServerClientFactory } = {},
): Promise<EmbeddedPiCompactResult | undefined> {
  const nativeExecutionBlock = resolveCodexNativeExecutionBlock({
    config: params.config,
    sessionKey: params.sandboxSessionKey ?? params.sessionKey,
    sessionId: params.sessionId,
    surface: "native compaction",
  });
  if (nativeExecutionBlock) {
    return { ok: false, compacted: false, reason: nativeExecutionBlock };
  }
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
  const binding = await readCodexAppServerBinding(params.sessionFile, { config: params.config });
  if (!binding?.threadId) {
    return failedCodexThreadBindingCompactionResult(params, {
      reason: "no codex app-server thread binding",
      recovery: "missing_thread_binding",
    });
  }
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  if (
    requestedAuthProfileId &&
    binding.authProfileId &&
    binding.authProfileId !== requestedAuthProfileId
  ) {
    return { ok: false, compacted: false, reason: "auth profile mismatch for session binding" };
  }

  const clientFactory = options.clientFactory ?? defaultCodexAppServerClientFactory;
  const client = await clientFactory(
    appServer.start,
    requestedAuthProfileId ?? binding.authProfileId,
    params.agentDir,
    params.config,
  );
  try {
    await client.request("thread/compact/start", {
      threadId: binding.threadId,
    });
    embeddedAgentLog.info("started codex app-server compaction", {
      sessionId: params.sessionId,
      threadId: binding.threadId,
    });
  } catch (error) {
    if (isCodexThreadNotFoundError(error)) {
      return failedCodexThreadBindingCompactionResult(params, {
        threadId: binding.threadId,
        reason: formatCompactionError(error),
        recovery: "stale_thread_binding",
      });
    }
    embeddedAgentLog.warn("codex app-server compaction failed", {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      threadId: binding.threadId,
      reason: formatCompactionError(error),
    });
    return {
      ok: false,
      compacted: false,
      reason: formatCompactionError(error),
    };
  }
  const resultDetails: JsonObject = {
    backend: "codex-app-server",
    threadId: binding.threadId,
    signal: "thread/compact/start",
    pending: true,
  };
  return {
    ok: true,
    compacted: false,
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: params.currentTokenCount ?? 0,
      details: resultDetails,
    },
  };
}

function failedCodexThreadBindingCompactionResult(
  params: CompactEmbeddedPiSessionParams,
  recovery: {
    reason: string;
    recovery: "missing_thread_binding" | "stale_thread_binding";
    threadId?: string;
  },
): EmbeddedPiCompactResult {
  embeddedAgentLog.warn("codex app-server compaction could not use thread binding", {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    threadId: recovery.threadId,
    reason: recovery.reason,
    recovery: recovery.recovery,
  });
  return {
    ok: false,
    compacted: false,
    reason: recovery.reason,
    failure: {
      reason: recovery.recovery,
      rawError: recovery.reason,
    },
  };
}

function isCodexThreadNotFoundError(error: unknown): boolean {
  return formatCompactionError(error).toLowerCase().includes("thread not found");
}

function formatCompactionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
