// Copilot plugin module implements fresh, zero-tool inference.
import { resolve } from "node:path";
import type { SessionConfig, SessionEvent } from "@github/copilot-sdk";
import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness-runtime";
import { tokenFingerprint } from "./auth-bridge.js";
import { createCopilotByokProxy } from "./byok-proxy.js";
import { resolveCopilotProvider } from "./provider-bridge.js";
import type { CopilotClientPool, PooledClient } from "./runtime.js";
import { createCopilotIsolatedSessionRestrictions } from "./session-restrictions.js";
import { buildCopilotAssistantUsage } from "./usage-bridge.js";

type AgentHarnessIsolatedCompletion = NonNullable<AgentHarness["runIsolatedCompletionV2"]>;
type AgentHarnessIsolatedCompletionParams = Parameters<AgentHarnessIsolatedCompletion>[0];
type AgentHarnessIsolatedCompletionResult = Awaited<ReturnType<AgentHarnessIsolatedCompletion>>;

type IsolatedSession = {
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  sendAndWait(
    prompt: { prompt: string; requestHeaders?: Record<string, string> },
    timeout?: number,
  ): Promise<SessionEvent | undefined>;
};

type CompletionBoundary = {
  abortSignal?: AbortSignal;
  assertCurrent?: () => void;
  deadlineMs: number;
  timeoutMs: number;
};

function startBestEffortCleanup(cleanup: () => Promise<void>): void {
  try {
    void cleanup().catch(() => undefined);
  } catch {
    // Completion outcome wins over best-effort SDK teardown.
  }
}

function resolveReasoningEffort(
  thinkLevel: AgentHarnessIsolatedCompletionParams["thinkLevel"],
): SessionConfig["reasoningEffort"] {
  return thinkLevel === "low" ||
    thinkLevel === "medium" ||
    thinkLevel === "high" ||
    thinkLevel === "xhigh"
    ? thinkLevel
    : undefined;
}

function createAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("aborted", signal.reason ? { cause: signal.reason } : undefined);
  error.name = "AbortError";
  return error;
}

function createTimeoutError(timeoutMs: number): Error {
  const error = new Error(`[copilot] isolated completion timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
}

async function awaitWithinCompletionBoundary<T>(params: {
  boundary: CompletionBoundary;
  start: (remainingMs: number) => Promise<T>;
  cleanupLate?: (value: T) => Promise<void>;
  onBoundary?: () => void;
}): Promise<T> {
  const signal = params.boundary.abortSignal;
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
  const remainingMs = params.boundary.deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw createTimeoutError(params.boundary.timeoutMs);
  }

  let boundaryWon = false;
  let boundaryError: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    const rejectBoundary = (error: Error) => {
      if (boundaryWon) {
        return;
      }
      boundaryWon = true;
      boundaryError = error;
      params.onBoundary?.();
      reject(error);
    };
    timer = setTimeout(
      () => rejectBoundary(createTimeoutError(params.boundary.timeoutMs)),
      remainingMs,
    );
    if (signal) {
      onAbort = () => rejectBoundary(createAbortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    }
  });
  // Start only after the abort listener exists. Pool/session factories may
  // synchronously trip cancellation before returning their promise.
  const operation = Promise.resolve()
    .then(() => {
      if (boundaryWon) {
        throw boundaryError ?? createTimeoutError(params.boundary.timeoutMs);
      }
      params.boundary.assertCurrent?.();
      return params.start(remainingMs);
    })
    .then(async (value) => {
      if (boundaryWon) {
        await params.cleanupLate?.(value);
      }
      return value;
    });
  try {
    return await Promise.race([operation, boundary]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function sendPrompt(params: {
  boundary: CompletionBoundary;
  prompt: string;
  requestHeaders?: Record<string, string>;
  session: IsolatedSession;
}): Promise<SessionEvent | undefined> {
  return await awaitWithinCompletionBoundary({
    boundary: params.boundary,
    start: async (remainingMs) =>
      await params.session.sendAndWait(
        {
          prompt: params.prompt,
          ...(params.requestHeaders ? { requestHeaders: params.requestHeaders } : {}),
        },
        remainingMs,
      ),
    onBoundary: () => {
      void params.session.abort().catch(() => undefined);
    },
  });
}

export async function runCopilotIsolatedCompletion(
  params: AgentHarnessIsolatedCompletionParams,
  getPool: () => Promise<CopilotClientPool>,
): Promise<AgentHarnessIsolatedCompletionResult> {
  const reasoningEffort = resolveReasoningEffort(params.thinkLevel);
  if (params.thinkLevel !== undefined && reasoningEffort === undefined) {
    throw new Error(
      `[copilot] isolated completion does not support thinking level ${params.thinkLevel}`,
    );
  }
  const boundary: CompletionBoundary = {
    abortSignal: params.abortSignal,
    assertCurrent: params.assertCurrent,
    deadlineMs: Date.now() + params.timeoutMs,
    timeoutMs: params.timeoutMs,
  };
  if (params.authorization.owner !== "host") {
    throw new Error("[copilot] isolated completion requires host-prepared authorization");
  }
  const authorization = params.authorization;
  const { auth, model } = authorization;
  const apiKey = auth.apiKey?.trim();
  if (!apiKey) {
    throw new Error("[copilot] isolated completion requires the prepared credential");
  }
  const resolvedProvider = resolveCopilotProvider({
    model: {
      api: model.api,
      id: model.id,
      provider: model.provider,
      baseUrl: model.baseUrl,
      headers: model.headers,
      authHeader: model.authHeader,
      contextTokens: model.contextTokens,
      contextWindow: model.contextWindow,
      maxTokens: params.streamParams?.maxTokens ?? model.maxTokens,
      azureApiVersion:
        typeof model.params?.azureApiVersion === "string"
          ? model.params.azureApiVersion
          : undefined,
    },
    resolvedApiKey: apiKey,
    authProfileId: auth.profileId,
  });
  // Sampling controls are best-effort completion hints. Native Copilot does
  // not expose equivalent SDK fields, while BYOK applies maxTokens above.
  const pool = await awaitWithinCompletionBoundary({
    boundary,
    start: getPool,
  });
  const byokProxy = await awaitWithinCompletionBoundary({
    boundary,
    start: async () => await createCopilotByokProxy(resolvedProvider),
    cleanupLate: async (proxy) => await proxy?.close(),
  });
  const sessionProvider = byokProxy?.provider ?? resolvedProvider;
  const githubAuth = sessionProvider.mode === "github-copilot";
  const copilotHome = resolve(params.agentDir, "copilot");
  const authProfileId = auth.profileId?.trim() || "prepared";
  const authProfileVersion =
    authorization.sourceAuthFingerprint?.trim() || tokenFingerprint(apiKey);
  let handle: PooledClient | undefined;
  let session: IsolatedSession | undefined;
  try {
    const acquiredHandle = await awaitWithinCompletionBoundary({
      boundary,
      start: async () =>
        await pool.acquire(
          {
            agentId: params.agentId,
            authMode: githubAuth ? "gitHubToken" : "byok",
            authProfileId,
            authProfileVersion,
            copilotHome,
            clientMode: "empty",
          },
          {
            copilotHome,
            mode: "empty",
            useLoggedInUser: false,
            ...(githubAuth ? { gitHubToken: apiKey } : {}),
          },
        ),
      cleanupLate: async (lateHandle) => await pool.release(lateHandle),
    });
    handle = acquiredHandle;
    const sessionConfig: SessionConfig = {
      ...createCopilotIsolatedSessionRestrictions(),
      model: model.id,
      ...(githubAuth ? { gitHubToken: apiKey } : {}),
      ...(sessionProvider.provider ? { provider: sessionProvider.provider } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      systemMessage: { mode: "replace", content: params.systemPrompt },
      workingDirectory: params.workspaceDir,
    };
    const createdSession = await awaitWithinCompletionBoundary({
      boundary,
      start: async () =>
        (await acquiredHandle.client.createSession(sessionConfig)) as unknown as IsolatedSession,
      cleanupLate: async (lateSession) => {
        startBestEffortCleanup(async () => await lateSession.abort());
        startBestEffortCleanup(async () => await lateSession.disconnect());
      },
    });
    session = createdSession;
    const event = await sendPrompt({
      boundary,
      prompt: params.prompt,
      requestHeaders: sessionProvider.provider?.headers,
      session: createdSession,
    });
    if (event?.type !== "assistant.message" || event.agentId !== undefined) {
      throw new Error("[copilot] isolated completion did not return a root assistant message");
    }
    const content: AgentHarnessIsolatedCompletionResult["assistant"]["content"] = [];
    if (event.data.reasoningText) {
      content.push({ type: "thinking", thinking: event.data.reasoningText });
    }
    if (event.data.content) {
      content.push({ type: "text", text: event.data.content });
    }
    for (const toolRequest of event.data.toolRequests ?? []) {
      const toolArguments = toolRequest.arguments;
      content.push({
        type: "toolCall",
        id: toolRequest.toolCallId,
        name: toolRequest.name,
        arguments:
          toolArguments && typeof toolArguments === "object" && !Array.isArray(toolArguments)
            ? { ...toolArguments }
            : {},
      });
    }
    return {
      assistant: {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: event.data.model ?? model.id,
        stopReason: event.data.toolRequests?.length ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: buildCopilotAssistantUsage({ fallbackOutputTokens: event.data.outputTokens }),
      },
    };
  } finally {
    // Teardown starts independently and remains strongly referenced, but never
    // extends the operation deadline when an SDK cleanup call wedges.
    if (session) {
      const sessionToClose = session;
      startBestEffortCleanup(async () => await sessionToClose.disconnect());
    }
    if (byokProxy) {
      startBestEffortCleanup(async () => await byokProxy.close());
    }
    if (handle) {
      const handleToRelease = handle;
      startBestEffortCleanup(async () => await pool.release(handleToRelease));
    }
  }
}
