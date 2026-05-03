import {
  embeddedAgentLog,
  formatErrorMessage,
  isActiveHarnessContextEngine,
  runHarnessContextEngineMaintenance,
  type CompactEmbeddedPiSessionParams,
  type EmbeddedPiCompactResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createCodexAppServerClientFactoryTestHooks,
  defaultCodexAppServerClientFactory,
} from "./client-factory.js";
import type { CodexAppServerClient, CodexServerNotificationHandler } from "./client.js";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import { isJsonObject, type CodexServerNotification, type JsonObject } from "./protocol.js";
import { readCodexAppServerBinding } from "./session-binding.js";
type CodexNativeCompactionCompletion = {
  signal: "thread/compacted" | "item/completed";
  turnId?: string;
  itemId?: string;
};
type CodexNativeCompactionWaiter = {
  promise: Promise<CodexNativeCompactionCompletion>;
  startTimeout: () => void;
  cancel: () => void;
};
type ContextEngineCompactResult = Awaited<
  ReturnType<NonNullable<CompactEmbeddedPiSessionParams["contextEngine"]>["compact"]>
>;

const DEFAULT_CODEX_COMPACTION_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

let clientFactory = defaultCodexAppServerClientFactory;

export async function maybeCompactCodexAppServerSession(
  params: CompactEmbeddedPiSessionParams,
  options: { pluginConfig?: unknown } = {},
): Promise<EmbeddedPiCompactResult | undefined> {
  const activeContextEngine = isActiveHarnessContextEngine(params.contextEngine)
    ? params.contextEngine
    : undefined;
  if (activeContextEngine?.info.ownsCompaction) {
    let primary: ContextEngineCompactResult | undefined;
    let primaryError: string | undefined;
    try {
      primary = await activeContextEngine.compact({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        tokenBudget: params.contextTokenBudget,
        currentTokenCount: params.currentTokenCount,
        compactionTarget: params.trigger === "manual" ? "threshold" : "budget",
        customInstructions: params.customInstructions,
        force: params.trigger === "manual",
        runtimeContext: params.contextEngineRuntimeContext,
      });
    } catch (error) {
      primaryError = formatErrorMessage(error);
      embeddedAgentLog.warn(
        "context engine compaction failed; attempting Codex native compaction",
        {
          sessionId: params.sessionId,
          engineId: activeContextEngine.info.id,
          error: primaryError,
        },
      );
    }
    if (primary?.ok && primary.compacted) {
      try {
        await runHarnessContextEngineMaintenance({
          contextEngine: activeContextEngine,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
          reason: "compaction",
          runtimeContext: params.contextEngineRuntimeContext,
          config: params.config,
        });
      } catch (error) {
        embeddedAgentLog.warn(
          "context engine compaction maintenance failed; continuing Codex native compaction",
          {
            sessionId: params.sessionId,
            engineId: activeContextEngine.info.id,
            error: formatErrorMessage(error),
          },
        );
      }
    }
    const nativeResult = await compactCodexNativeThread(params, options);
    if (!primary) {
      return buildContextEngineCompactionFailureResult({
        primaryError,
        nativeResult,
        currentTokenCount: params.currentTokenCount,
      });
    }
    return {
      ok: primary.ok,
      compacted: primary.compacted,
      reason: primary.reason,
      result: buildContextEnginePrimaryResult(primary, nativeResult, params.currentTokenCount),
    };
  }
  return await compactCodexNativeThread(params, options);
}

async function compactCodexNativeThread(
  params: CompactEmbeddedPiSessionParams,
  options: { pluginConfig?: unknown } = {},
): Promise<EmbeddedPiCompactResult | undefined> {
  const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
  const binding = await readCodexAppServerBinding(params.sessionFile);
  if (!binding?.threadId) {
    return { ok: false, compacted: false, reason: "no codex app-server thread binding" };
  }
  const requestedAuthProfileId = params.authProfileId?.trim() || undefined;
  if (
    requestedAuthProfileId &&
    binding.authProfileId &&
    binding.authProfileId !== requestedAuthProfileId
  ) {
    return { ok: false, compacted: false, reason: "auth profile mismatch for session binding" };
  }

  const client = await clientFactory(
    appServer.start,
    requestedAuthProfileId ?? binding.authProfileId,
    params.agentDir,
  );
  const waiter = createCodexNativeCompactionWaiter(client, binding.threadId);
  let completion: CodexNativeCompactionCompletion;
  try {
    await client.request("thread/compact/start", {
      threadId: binding.threadId,
    });
    embeddedAgentLog.info("started codex app-server compaction", {
      sessionId: params.sessionId,
      threadId: binding.threadId,
    });
    waiter.startTimeout();
    completion = await waiter.promise;
  } catch (error) {
    waiter.cancel();
    return {
      ok: false,
      compacted: false,
      reason: formatCompactionError(error),
    };
  }
  embeddedAgentLog.info("completed codex app-server compaction", {
    sessionId: params.sessionId,
    threadId: binding.threadId,
    signal: completion.signal,
    turnId: completion.turnId,
    itemId: completion.itemId,
  });
  return {
    ok: true,
    compacted: true,
    result: {
      summary: "",
      firstKeptEntryId: "",
      tokensBefore: params.currentTokenCount ?? 0,
      details: {
        backend: "codex-app-server",
        ownsCompaction: params.contextEngine?.info?.ownsCompaction === true,
        threadId: binding.threadId,
        signal: completion.signal,
        turnId: completion.turnId,
        itemId: completion.itemId,
      },
    },
  };
}

function mergeCompactionDetails(
  primaryDetails: unknown,
  nativeResult: EmbeddedPiCompactResult | undefined,
  contextEngineCompaction?: { ok: false; reason?: string },
): unknown {
  const codexNativeCompaction = nativeResult
    ? nativeResult.ok && nativeResult.compacted
      ? { ok: true, compacted: true, details: nativeResult.result?.details }
      : { ok: false, compacted: false, reason: nativeResult.reason }
    : undefined;
  const extraDetails = {
    ...(codexNativeCompaction ? { codexNativeCompaction } : {}),
    ...(contextEngineCompaction ? { contextEngineCompaction } : {}),
  };
  if (primaryDetails && typeof primaryDetails === "object" && !Array.isArray(primaryDetails)) {
    return {
      ...(primaryDetails as Record<string, unknown>),
      ...extraDetails,
    };
  }
  return Object.keys(extraDetails).length > 0 ? extraDetails : primaryDetails;
}

function buildContextEnginePrimaryResult(
  primary: ContextEngineCompactResult,
  nativeResult: EmbeddedPiCompactResult | undefined,
  currentTokenCount: number | undefined,
): NonNullable<EmbeddedPiCompactResult["result"]> | undefined {
  if (primary.result) {
    return {
      summary: primary.result.summary ?? "",
      firstKeptEntryId: primary.result.firstKeptEntryId ?? "",
      tokensBefore: primary.result.tokensBefore,
      tokensAfter: primary.result.tokensAfter,
      details: mergeCompactionDetails(primary.result.details, nativeResult),
    };
  }
  const details = mergeCompactionDetails(undefined, nativeResult);
  return details
    ? {
        summary: "",
        firstKeptEntryId: "",
        tokensBefore: nativeResult?.result?.tokensBefore ?? currentTokenCount ?? 0,
        details,
      }
    : undefined;
}

function buildContextEngineCompactionFailureResult(params: {
  primaryError?: string;
  nativeResult: EmbeddedPiCompactResult | undefined;
  currentTokenCount?: number;
}): EmbeddedPiCompactResult {
  const reason = params.primaryError
    ? `context engine compaction failed: ${params.primaryError}`
    : "context engine compaction failed";
  return {
    ok: false,
    compacted: params.nativeResult?.compacted ?? false,
    reason,
    result: {
      summary: params.nativeResult?.result?.summary ?? "",
      firstKeptEntryId: params.nativeResult?.result?.firstKeptEntryId ?? "",
      tokensBefore: params.nativeResult?.result?.tokensBefore ?? params.currentTokenCount ?? 0,
      tokensAfter: params.nativeResult?.result?.tokensAfter,
      details: mergeCompactionDetails(params.nativeResult?.result?.details, params.nativeResult, {
        ok: false,
        reason,
      }),
    },
  };
}

function createCodexNativeCompactionWaiter(
  client: CodexAppServerClient,
  threadId: string,
): CodexNativeCompactionWaiter {
  let settled = false;
  let removeHandler: () => void = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let failWaiter: (error: Error) => void = () => {};

  const promise = new Promise<CodexNativeCompactionCompletion>((resolve, reject) => {
    const cleanup = (): void => {
      removeHandler();
      if (timeout) {
        clearTimeout(timeout);
      }
    };
    const complete = (completion: CodexNativeCompactionCompletion): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(completion);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    failWaiter = fail;
    const handler: CodexServerNotificationHandler = (notification) => {
      const completion = readNativeCompactionCompletion(notification, threadId);
      if (completion) {
        complete(completion);
      }
    };
    removeHandler = client.addNotificationHandler(handler);
  });

  return {
    promise,
    startTimeout(): void {
      if (settled || timeout) {
        return;
      }
      timeout = setTimeout(() => {
        failWaiter(new Error(`timed out waiting for codex app-server compaction for ${threadId}`));
      }, resolveCompactionWaitTimeoutMs());
      timeout.unref?.();
    },
    cancel(): void {
      if (settled) {
        return;
      }
      settled = true;
      removeHandler();
      if (timeout) {
        clearTimeout(timeout);
      }
    },
  };
}

function readNativeCompactionCompletion(
  notification: CodexServerNotification,
  threadId: string,
): CodexNativeCompactionCompletion | undefined {
  const params = notification.params;
  if (!isJsonObject(params) || readString(params, "threadId", "thread_id") !== threadId) {
    return undefined;
  }
  if (notification.method === "thread/compacted") {
    return {
      signal: "thread/compacted",
      turnId: readString(params, "turnId", "turn_id"),
    };
  }
  if (notification.method !== "item/completed") {
    return undefined;
  }
  const item = isJsonObject(params.item) ? params.item : undefined;
  if (readString(item, "type") !== "contextCompaction") {
    return undefined;
  }
  return {
    signal: "item/completed",
    turnId: readString(params, "turnId", "turn_id"),
    itemId: readString(item, "id") ?? readString(params, "itemId", "item_id", "id"),
  };
}

function resolveCompactionWaitTimeoutMs(): number {
  const raw = process.env.OPENCLAW_CODEX_COMPACTION_WAIT_TIMEOUT_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return DEFAULT_CODEX_COMPACTION_WAIT_TIMEOUT_MS;
}

function readString(params: JsonObject | undefined, ...keys: string[]): string | undefined {
  if (!params) {
    return undefined;
  }
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function formatCompactionError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export const __testing = createCodexAppServerClientFactoryTestHooks((factory) => {
  clientFactory = factory;
});
