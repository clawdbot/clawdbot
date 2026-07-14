import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  cleanupSessionLifecycleArtifacts,
  formatSqliteSessionFileMarker,
  patchSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { tempWorkspace, resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  applyActiveMemoryRuntimeConfigSnapshot,
  isMissingRegisteredMemoryToolsError,
  requireTransientWorkspaceDir,
  resolvePersistentTranscriptBaseDir,
  resolveSafeTranscriptDir,
} from "./config.js";
import { buildRecallPrompt } from "./prompt.js";
import { getModelRef } from "./query.js";
import { toSingleLineLogValue } from "./recall-state.js";
import {
  resolveCanonicalSessionKeyFromSessionId,
  resolveRecallRunChannelContext,
} from "./session.js";
import {
  attachPartialTimeoutData,
  readMemoryToolResultEvidence,
  readPartialAssistantTextFromSources,
} from "./transcript-result.js";
import {
  readActiveMemorySearchDebugFromRunResult,
  readActiveMemorySessionFileFromRunResult,
  readMergedActiveMemoryTranscriptState,
} from "./transcript-watch.js";
import { fileTranscriptSource, transcriptSourceFromReturnedSessionFile } from "./transcript.js";
import {
  ACTIVE_MEMORY_CLEANUP_RETRY_DELAYS_MS,
  ACTIVE_MEMORY_RECALL_LANE,
  type ActiveMemoryTranscriptSource,
  type RecallSubagentResult,
  type ResolvedActiveRecallPluginConfig,
} from "./types.js";

function collectActiveMemoryTranscriptSources(params: {
  artifactSessionFile: string;
  runtimeSource: ActiveMemoryTranscriptSource;
  activeSessionFile?: string;
  activeSessionKey: string;
}): ActiveMemoryTranscriptSource[] {
  const sources: ActiveMemoryTranscriptSource[] = [params.runtimeSource];
  sources.push(fileTranscriptSource(params.artifactSessionFile));
  if (params.activeSessionFile && params.activeSessionFile !== params.artifactSessionFile) {
    sources.push(
      transcriptSourceFromReturnedSessionFile({
        sessionFile: params.activeSessionFile,
        sessionKey: params.activeSessionKey,
      }),
    );
  }
  return sources;
}

async function persistActiveMemoryTranscriptArtifact(params: {
  sources: readonly ActiveMemoryTranscriptSource[];
  sessionFile: string;
}): Promise<void> {
  const events: unknown[] = [];
  const seen = new Set<string>();
  for (const source of params.sources) {
    if (source.kind !== "runtime") {
      continue;
    }
    let sourceEvents: readonly unknown[];
    try {
      sourceEvents = await readSessionTranscriptEvents(source.target);
    } catch {
      continue;
    }
    for (const event of sourceEvents) {
      const serialized = JSON.stringify(event);
      if (seen.has(serialized)) {
        continue;
      }
      seen.add(serialized);
      events.push(event);
    }
  }
  if (events.length === 0) {
    return;
  }
  await fs.mkdir(path.dirname(params.sessionFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(
    params.sessionFile,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

async function cleanupActiveMemoryRecallSession(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  const sessionKeySegmentPrefix =
    parseAgentSessionKey(params.sessionKey)?.rest ?? params.sessionKey;
  let lastError: unknown;
  for (const delayMs of ACTIVE_MEMORY_CLEANUP_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    try {
      const result = await cleanupSessionLifecycleArtifacts({
        agentId: params.agentId,
        archiveRemovedEntryTranscripts: false,
        orphanTranscriptMinAgeMs: 0,
        sessionKeySegmentPrefix,
        storePath: params.storePath,
        transcriptContentMarker: `"runId":"${params.sessionId}"`,
      });
      if (result.removedEntries !== 1) {
        throw new Error(
          `active-memory recall cleanup removed ${String(result.removedEntries)} sessions`,
        );
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`active-memory recall cleanup failed: ${String(lastError)}`);
}

async function runRecallSubagent(params: {
  api: OpenClawPluginApi;
  config: ResolvedActiveRecallPluginConfig;
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  messageProvider?: string;
  channelId?: string;
  query: string;
  searchQuery: string;
  currentModelProviderId?: string;
  currentModelId?: string;
  modelRef?: { provider: string; model: string };
  abortSignal?: AbortSignal;
  onTranscriptSources?: (sources: readonly ActiveMemoryTranscriptSource[]) => void;
}): Promise<RecallSubagentResult> {
  const workspaceDir = resolveAgentWorkspaceDir(params.api.config, params.agentId);
  const agentDir = resolveAgentDir(params.api.config, params.agentId);
  const modelRef =
    params.modelRef ??
    getModelRef(params.api, params.agentId, params.config, {
      modelProviderId: params.currentModelProviderId,
      modelId: params.currentModelId,
    });
  if (!modelRef) {
    return { rawReply: "NONE" };
  }
  const subagentSessionId = `active-memory-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const parentSessionKey =
    params.sessionKey ??
    resolveCanonicalSessionKeyFromSessionId({
      api: params.api,
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
  const subagentScope = parentSessionKey ?? params.sessionId ?? crypto.randomUUID();
  const subagentSuffix = `active-memory:${crypto
    .createHash("sha1")
    .update(`${subagentScope}:${params.query}:${subagentSessionId}`)
    .digest("hex")
    .slice(0, 12)}`;
  const subagentSessionKey = parentSessionKey
    ? `${parentSessionKey}:${subagentSuffix}`
    : `agent:${params.agentId}:${subagentSuffix}`;
  const transientWorkspace = params.config.persistTranscripts
    ? undefined
    : await tempWorkspace({
        rootDir: resolvePreferredOpenClawTmpDir(),
        prefix: "openclaw-active-memory-",
      });
  const tempDir = transientWorkspace?.dir;
  const persistedDir = params.config.persistTranscripts
    ? resolveSafeTranscriptDir(
        resolvePersistentTranscriptBaseDir(params.api, params.agentId),
        params.config.transcriptDir,
      )
    : undefined;
  const artifactSessionFile =
    persistedDir !== undefined
      ? path.join(persistedDir, `${subagentSessionId}.jsonl`)
      : path.join(requireTransientWorkspaceDir(tempDir), "session.jsonl");
  const storePath = params.api.runtime.agent.session.resolveStorePath(
    params.api.config.session?.store,
    {
      agentId: params.agentId,
    },
  );
  const runtimeSessionFile = formatSqliteSessionFileMarker({
    agentId: params.agentId,
    sessionId: subagentSessionId,
    storePath,
  });
  const runtimeSource: ActiveMemoryTranscriptSource = {
    kind: "runtime",
    target: {
      agentId: params.agentId,
      sessionId: subagentSessionId,
      sessionKey: subagentSessionKey,
      storePath,
    },
  };
  let transcriptSources = collectActiveMemoryTranscriptSources({
    artifactSessionFile,
    runtimeSource,
    activeSessionKey: subagentSessionKey,
  });

  let harnessHasUsableMemoryResult = false;
  let harnessHasUnavailableMemorySearchResult = false;
  let transcriptArtifactPersisted = false;
  let runtimeSessionCreated = false;
  try {
    const runtimeEntry = {
      pluginOwnerId: params.api.id,
      sessionId: subagentSessionId,
      sessionFile: runtimeSessionFile,
      updatedAt: Date.now(),
    };
    const createdEntry = await patchSessionEntry({
      agentId: params.agentId,
      fallbackEntry: runtimeEntry,
      replaceEntry: true,
      sessionKey: subagentSessionKey,
      skipMaintenance: true,
      storePath,
      update: (_entry, context) => (context.existingEntry ? null : runtimeEntry),
    });
    if (createdEntry?.sessionId !== subagentSessionId) {
      throw new Error(`active-memory recall session already exists: ${subagentSessionKey}`);
    }
    runtimeSessionCreated = true;
    params.onTranscriptSources?.(transcriptSources);
    if (persistedDir) {
      await fs.mkdir(persistedDir, { recursive: true, mode: 0o700 });
      await fs.chmod(persistedDir, 0o700).catch(() => undefined);
    }
    const prompt = buildRecallPrompt({
      config: params.config,
      query: params.query,
      searchQuery: params.searchQuery,
    });
    const { messageChannel, messageProvider } = resolveRecallRunChannelContext({
      api: params.api,
      agentId: params.agentId,
      sessionKey: parentSessionKey,
      sessionId: params.sessionId,
      messageProvider: params.messageProvider,
      channelId: params.channelId,
    });
    const embeddedConfig = applyActiveMemoryRuntimeConfigSnapshot(params.api.config, params.config);
    const embeddedTimeoutMs = params.config.timeoutMs + params.config.setupGraceTimeoutMs;
    const result = await params.api.runtime.agent.runEmbeddedAgent({
      sessionId: subagentSessionId,
      sessionKey: subagentSessionKey,
      agentId: params.agentId,
      sessionTarget: {
        agentId: params.agentId,
        sessionId: subagentSessionId,
        sessionKey: subagentSessionKey,
        storePath,
      },
      messageChannel,
      messageProvider,
      sessionFile: runtimeSessionFile,
      workspaceDir,
      agentDir,
      config: embeddedConfig,
      prompt,
      provider: modelRef.provider,
      model: modelRef.model,
      lane: ACTIVE_MEMORY_RECALL_LANE,
      timeoutMs: embeddedTimeoutMs,
      runId: subagentSessionId,
      trigger: "manual",
      toolsAllow: [...params.config.toolsAllow],
      disableMessageTool: true,
      allowGatewaySubagentBinding: true,
      bootstrapContextMode: "lightweight",
      verboseLevel: "off",
      thinkLevel: params.config.thinking,
      reasoningLevel: "off",
      silentExpected: true,
      authProfileFailurePolicy: "local",
      cleanupBundleMcpOnRunEnd: true,
      abortSignal: params.abortSignal,
      onAgentToolResult: (event) => {
        const evidence = readMemoryToolResultEvidence({
          ...event,
          toolsAllow: params.config.toolsAllow,
        });
        harnessHasUsableMemoryResult ||= evidence.hasUsableMemoryResult;
        harnessHasUnavailableMemorySearchResult ||= evidence.hasUnavailableMemorySearchResult;
      },
    });
    const activeSessionFile =
      readActiveMemorySessionFileFromRunResult(result) ?? runtimeSessionFile;
    transcriptSources = collectActiveMemoryTranscriptSources({
      artifactSessionFile,
      runtimeSource,
      activeSessionFile,
      activeSessionKey: subagentSessionKey,
    });
    params.onTranscriptSources?.(transcriptSources);
    if (params.abortSignal?.aborted) {
      const reason = params.abortSignal.reason;
      if (reason instanceof Error) {
        throw reason;
      }
      const abortErr =
        reason !== undefined
          ? new Error("Operation aborted", { cause: reason })
          : new Error("Operation aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }
    const rawReply = (result.payloads ?? [])
      .map((payload) => payload.text?.trim() ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
    if (params.config.persistTranscripts) {
      await persistActiveMemoryTranscriptArtifact({
        sources: transcriptSources,
        sessionFile: artifactSessionFile,
      });
      transcriptArtifactPersisted = true;
    }
    const transcriptState = await readMergedActiveMemoryTranscriptState({
      sources: transcriptSources,
      toolsAllow: params.config.toolsAllow,
    });
    const searchDebug =
      transcriptState.searchDebug ?? readActiveMemorySearchDebugFromRunResult(result);
    return {
      rawReply: rawReply || "NONE",
      transcriptPath: params.config.persistTranscripts ? artifactSessionFile : undefined,
      searchDebug,
      hasUsableMemoryResult: transcriptState.hasUsableMemoryResult || harnessHasUsableMemoryResult,
      hasUnavailableMemorySearchResult:
        transcriptState.hasUnavailableMemorySearchResult || harnessHasUnavailableMemorySearchResult,
    };
  } catch (error) {
    if (params.abortSignal?.aborted) {
      const partialReply = await readPartialAssistantTextFromSources(transcriptSources);
      const transcriptState = await readMergedActiveMemoryTranscriptState({
        sources: transcriptSources,
        toolsAllow: params.config.toolsAllow,
      });
      attachPartialTimeoutData(
        error,
        partialReply,
        transcriptState.searchDebug,
        transcriptState.hasUnavailableMemorySearchResult || harnessHasUnavailableMemorySearchResult,
      );
    }
    if (
      !params.abortSignal?.aborted &&
      isMissingRegisteredMemoryToolsError(error, params.config.toolsAllow)
    ) {
      params.api.logger.debug?.(
        `active-memory: no configured memory tools available; skipping sub-agent`,
      );
      return { rawReply: "NONE", resultStatus: "unavailable" };
    }
    if (!params.abortSignal?.aborted) {
      const message = toSingleLineLogValue(error instanceof Error ? error.message : String(error));
      params.api.logger.warn?.(
        `active-memory: memory sub-agent failed, skipping recall: ${message}`,
      );
      return { rawReply: "NONE", resultStatus: "failed" };
    }
    throw error;
  } finally {
    try {
      if (runtimeSessionCreated) {
        if (params.config.persistTranscripts && !transcriptArtifactPersisted) {
          await persistActiveMemoryTranscriptArtifact({
            sources: transcriptSources,
            sessionFile: artifactSessionFile,
          }).catch((error: unknown) => {
            const message = toSingleLineLogValue(
              error instanceof Error ? error.message : String(error),
            );
            params.api.logger.debug?.(
              `active-memory: failed to persist recall transcript ${artifactSessionFile}: ${message}`,
            );
          });
        }
        await cleanupActiveMemoryRecallSession({
          agentId: params.agentId,
          sessionId: subagentSessionId,
          sessionKey: subagentSessionKey,
          storePath,
        }).catch((error: unknown) => {
          const message = toSingleLineLogValue(
            error instanceof Error ? error.message : String(error),
          );
          params.api.logger.warn?.(
            `active-memory: failed to clean up recall session ${subagentSessionKey}: ${message}`,
          );
          throw error;
        });
      }
    } finally {
      await transientWorkspace?.cleanup();
    }
  }
}

export { runRecallSubagent };
