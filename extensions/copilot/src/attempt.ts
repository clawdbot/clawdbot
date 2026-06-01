import fsp from "node:fs/promises";
import type { MessageOptions, SessionConfig, Tool as SdkTool } from "@github/copilot-sdk";
import type {
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentMessage,
  SandboxContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  detectAndLoadAgentHarnessPromptImages,
  resolveAttemptFsWorkspaceOnly,
  resolveAttemptSpawnWorkspaceDir,
  resolveSandboxContext as defaultResolveSandboxContext,
  resolveSessionAgentIds,
  resolveUserPath,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCopilotAuth } from "./auth-bridge.js";
import {
  createInfiniteSessionConfig,
  type CopilotInfiniteSessionOptions,
} from "./compaction-bridge.js";
import {
  attachCopilotMirrorIdentity,
  dualWriteCopilotTranscriptBestEffort,
} from "./dual-write-transcripts.js";
import {
  attachEventBridge,
  type AssistantMessage,
  type AssistantUsageSnapshot,
  type OnAssistantDeltaPayload,
  type SessionLike,
} from "./event-bridge.js";
import { createHooksBridge, type CopilotHooksConfig } from "./hooks-bridge.js";
import {
  createPermissionBridge,
  rejectAllPolicy,
  type CopilotPermissionPolicy,
} from "./permission-bridge.js";
import {
  classifyResumeFailure,
  computeReplayMetadata,
  copilotToolMetasHavePotentialSideEffects,
  decideReplayAction,
} from "./replay-shim.js";
import type { ClientCreateOptions, CopilotClientPool, PoolKey, PooledClient } from "./runtime.js";
import { createCopilotToolBridge } from "./tool-bridge.js";
import { resolveCopilotWorkspaceBootstrapContext } from "./workspace-bootstrap.js";

const SUPPORTED_PROVIDERS = new Set(["github-copilot"]);

type AttemptResultWithSdkSessionId = AgentHarnessAttemptResult & { sdkSessionId?: string };
type PromptErrorWithCode = Error & { code?: string; cause?: unknown };
export type CopilotSessionConfig = Pick<
  SessionConfig,
  | "availableTools"
  | "enableSessionTelemetry"
  | "gitHubToken"
  | "hooks"
  | "instructionDirectories"
  | "infiniteSessions"
  | "model"
  | "onPermissionRequest"
  | "reasoningEffort"
  | "systemMessage"
  | "tools"
  | "workingDirectory"
>;
// NOTE(plugin-sdk-widening): AttemptParamsLike can be removed once
// openclaw/plugin-sdk/agent-harness-runtime declares auth, messages,
// onAssistantDelta, and initialReplayState.sdkSessionId fields. Tracked by
// project openclaw-copilot-harness; reviewer-attempt-bridge note.

type AttemptParamsLike = AgentHarnessAttemptParams & {
  auth?: {
    gitHubToken?: string;
    profileId?: string;
    profileVersion?: string;
    useLoggedInUser?: boolean;
  };
  copilotHome?: string;
  cwd?: string;
  enableSessionTelemetry?: boolean;
  hooksConfig?: CopilotHooksConfig;
  infiniteSessionConfig?: CopilotInfiniteSessionOptions;
  initialReplayState?: AgentHarnessAttemptParams["initialReplayState"] & { sdkSessionId?: string };
  messages?: AgentMessage[];
  model?: string | { api?: string; id?: string; input?: string[]; provider?: string };
  onAssistantDelta?: (payload: OnAssistantDeltaPayload) => void | Promise<void>;
  permissionPolicy?: CopilotPermissionPolicy;
  profileVersion?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  // User-visible prompt body (when distinct from `prompt`, which may
  // include runtime-expanded context). Used when synthesizing the
  // current-turn user message for the OpenClaw audit transcript so
  // dashboard/CLI history shows what the user actually typed, not the
  // internal expansion. Symmetric to `EmbeddedRunAttemptParams.transcriptPrompt`.
  transcriptPrompt?: string;
};
type ModelRef = { api?: string; id: string; provider: string };

export type { AttemptParamsLike as CopilotPoolAcquireInput, ModelRef };
export { SUPPORTED_PROVIDERS };

export type ResolveSandboxContextFn = typeof defaultResolveSandboxContext;

export interface CopilotAttemptDeps {
  pool: CopilotClientPool;
  now?: () => number;
  createToolBridge?: typeof createCopilotToolBridge;
  /**
   * Optional override for sandbox-context resolution. The default delegates to
   * `openclaw/plugin-sdk/agent-harness-runtime#resolveSandboxContext`, which is
   * the same path PI uses. Tests inject a stub here to avoid the real
   * resolver's side effects (container provisioning, registry writes).
   */
  resolveSandboxContextOverride?: ResolveSandboxContextFn;
  /**
   * Called once with the SDK session id and pooled client immediately
   * after the SDK session is created (or resumed) successfully. The
   * harness uses this to track the openclawSessionId -> sdkSessionId
   * mapping needed for `reset(params)` (see harness.ts). Exceptions
   * thrown from this callback are swallowed so they cannot break the
   * attempt.
   */
  onSessionEstablished?: (info: {
    sdkSessionId: string;
    pooledClient: PooledClient;
    sessionConfig: CopilotSessionConfig;
  }) => void;
}

export async function runCopilotAttempt(
  params: AgentHarnessAttemptParams,
  deps: CopilotAttemptDeps,
): Promise<AgentHarnessAttemptResult> {
  const now = deps.now ?? Date.now;
  const input = params as AttemptParamsLike;
  const createToolBridge = deps.createToolBridge ?? createCopilotToolBridge;
  const messages = getMessagesSnapshotInput(input);

  if (params.abortSignal?.aborted) {
    return createResult(input, {
      aborted: true,
      externalAbort: true,
      messagesSnapshot: messages,
      now,
      promptError: undefined,
      sdkSessionId: undefined,
      sessionIdUsed: input.sessionId,
    });
  }

  const modelRef = resolveModelRef(input);
  if (!SUPPORTED_PROVIDERS.has(modelRef.provider)) {
    return createResult(input, {
      messagesSnapshot: messages,
      now,
      promptError: createPromptError(
        "model_not_supported",
        `[copilot-attempt] provider ${modelRef.provider} is not supported at MVP (subscription Copilot models only; BYOK arrives via byok-mapping-skeleton)`,
      ),
      sdkSessionId: undefined,
      sessionIdUsed: input.sessionId,
    });
  }

  let abortRequested = false;
  let aborted = false;
  let externalAbort = false;
  let settled = false;
  let sentTurnStarted = false;
  let timedOut = false;
  let promptError: Error | undefined;
  let sdkSessionId: string | undefined;
  let sessionIdUsed = input.sessionId;
  let disconnectError: Error | undefined;
  let handle: PooledClient | undefined;
  let session: SessionLike | undefined;
  let bridge: ReturnType<typeof attachEventBridge> | undefined;
  let releaseError: Error | undefined;
  let downgradedFromResume = false;
  let resumeFailureRecovered = false;
  // True when a wrapped tool fired `sessions_yield`. Propagated into
  // the final attempt result so the parent runner can mark liveness
  // as paused and stop_reason as `end_turn`, matching the in-tree PI
  // (`src/agents/pi-embedded-runner/run/attempt.ts:1107-1113`) and
  // codex (`extensions/codex/src/app-server/run-attempt.ts:539,1739`)
  // behavior. See `EmbeddedRunAttemptResult.yieldDetected` at
  // `src/agents/pi-embedded-runner/run/types.ts:139`.
  let yieldDetected = false;

  const onAbort = () => {
    abortRequested = true;
    externalAbort = true;
    aborted = true;
    if (settled || !sentTurnStarted || !session) {
      return;
    }
    void session.abort().catch(() => undefined);
  };

  params.abortSignal?.addEventListener("abort", onAbort, { once: true });

  // Sandbox parity with PI (`src/agents/pi-embedded-runner/run/attempt.ts:1232-1244`):
  // resolve the sandbox context using the same session-key derivation, then
  // compute the workspace dir the SDK should see vs the original workspace
  // spawned subagents should inherit. When sandbox is disabled (the default),
  // `resolveSandboxContext` returns `null` and behavior is unchanged from the
  // pre-fix path.
  const resolvedWorkspaceForSandbox =
    readResolvedAttemptPath(input.workspaceDir) ?? readResolvedAttemptPath(input.cwd);
  const sandboxSessionKey =
    readString((input as { sandboxSessionKey?: unknown }).sandboxSessionKey) ??
    readString((input as { sessionKey?: unknown }).sessionKey) ??
    readString(input.sessionId);
  const resolveSandbox = deps.resolveSandboxContextOverride ?? defaultResolveSandboxContext;
  let sandbox: SandboxContext | null = null;
  let effectiveWorkspaceDir = resolvedWorkspaceForSandbox;
  if (resolvedWorkspaceForSandbox) {
    try {
      sandbox = await resolveSandbox({
        config: input.config,
        sessionKey: sandboxSessionKey,
        workspaceDir: resolvedWorkspaceForSandbox,
      });
      effectiveWorkspaceDir = sandbox?.enabled
        ? sandbox.workspaceAccess === "rw"
          ? resolvedWorkspaceForSandbox
          : sandbox.workspaceDir
        : resolvedWorkspaceForSandbox;
      // Only ensure the workspace exists when sandbox redirected us to a
      // newly-resolved path. The original workspace is owned by the
      // orchestrator (PI's runner pre-creates it before entering the
      // attempt); duplicating the mkdir here would also break long-standing
      // tests that pass placeholder workspaceDir values.
      if (
        sandbox?.enabled &&
        effectiveWorkspaceDir &&
        effectiveWorkspaceDir !== resolvedWorkspaceForSandbox
      ) {
        await fsp.mkdir(effectiveWorkspaceDir, { recursive: true });
      }
    } catch (error: unknown) {
      settled = true;
      params.abortSignal?.removeEventListener("abort", onAbort);
      if (abortRequested || params.abortSignal?.aborted) {
        return createResult(input, {
          aborted: true,
          externalAbort: true,
          messagesSnapshot: messages,
          now,
          promptError: undefined,
          sdkSessionId: undefined,
          sessionIdUsed: input.sessionId,
        });
      }
      return createResult(input, {
        messagesSnapshot: messages,
        now,
        promptError: createPromptError(
          "sandbox_resolution_failure",
          `[copilot-attempt] sandbox resolution failed: ${toError(error).message}`,
          error,
        ),
        sdkSessionId: undefined,
        sessionIdUsed: input.sessionId,
      });
    }
  }
  const requestedCwd = readResolvedAttemptPath(input.cwd);
  if (sandbox?.enabled && requestedCwd && requestedCwd !== resolvedWorkspaceForSandbox) {
    settled = true;
    params.abortSignal?.removeEventListener("abort", onAbort);
    return createResult(input, {
      messagesSnapshot: messages,
      now,
      promptError: createPromptError(
        "sandbox_cwd_override_unsupported",
        "[copilot-attempt] cwd override is not supported for sandboxed Copilot runs; omit cwd or use the agent workspace as cwd",
      ),
      sdkSessionId: undefined,
      sessionIdUsed: input.sessionId,
    });
  }
  const effectiveCwd = sandbox?.enabled
    ? effectiveWorkspaceDir
    : (requestedCwd ?? effectiveWorkspaceDir);
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: readString((input as { sessionKey?: unknown }).sessionKey),
    config: input.config,
    agentId: readString(params.agentId),
  });
  const effectiveFsWorkspaceOnly = resolveAttemptFsWorkspaceOnly({
    config: input.config,
    sessionAgentId,
  });
  const sandboxAwareSpawnWorkspaceDir = resolvedWorkspaceForSandbox
    ? resolveAttemptSpawnWorkspaceDir({
        sandbox,
        resolvedWorkspace: resolvedWorkspaceForSandbox,
      })
    : undefined;

  const poolAcquire = resolvePoolAcquire(input);

  // Mutable session holder shared with the tool bridge so onYield
  // (raised inside wrapped-tool execution) can route to the live SDK
  // session's abort once it exists. The bridge is constructed before
  // createSession/resumeSession resolves, so the holder is the only
  // safe way to defer the binding without creating a circular dep.
  // See tool-bridge.ts CopilotSessionHolder.
  const sessionRef: { current: SessionLike | undefined } = { current: undefined };

  try {
    let sdkTools: SdkTool[];
    try {
      const toolBridge = await createToolBridge({
        modelProvider: modelRef.provider,
        modelId: modelRef.id,
        agentId: readString(params.agentId) ?? "copilot",
        sessionId: readString(input.sessionId) ?? "copilot-session",
        sessionKey: readString((input as { sessionKey?: unknown }).sessionKey),
        agentDir: readString(input.agentDir),
        // Sandbox parity (`src/agents/pi-embedded-runner/run/attempt.ts:1438-1450`):
        // bridged tools see the *effective* workspace (sandbox copy when not `rw`),
        // while spawned subagents inherit the *original* workspace.
        workspaceDir: effectiveWorkspaceDir,
        cwd: effectiveCwd,
        sandbox,
        spawnWorkspaceDir: sandboxAwareSpawnWorkspaceDir,
        abortSignal: params.abortSignal,
        // Forward the full attempt params so the wrapped-tool
        // enforcement layer receives the same context PI does
        // (identity, owner-only allowlist, auth-profile store,
        // channel/routing, model context, run hooks). See
        // tool-bridge.ts buildOpenClawCodingToolsOptions().
        attemptParams: input,
        sessionRef,
        onYieldDetected: () => {
          yieldDetected = true;
        },
      });
      sdkTools = toolBridge.sdkTools;
    } catch (error: unknown) {
      return createResult(input, {
        messagesSnapshot: messages,
        now,
        promptError: createPromptError(
          "tool_bridge_failure",
          `[copilot-attempt] tool-bridge construction failed: ${toError(error).message}`,
          error,
        ),
        sdkSessionId: undefined,
        sessionIdUsed: input.sessionId,
      });
    }

    handle = await deps.pool.acquire(poolAcquire.key, poolAcquire.options);
    const client = handle.client;
    // Load OpenClaw workspace bootstrap files (SOUL.md, IDENTITY.md,
    // HEARTBEAT.md, ...) before constructing the SDK SessionConfig so
    // persona/identity/heartbeat reach the model via
    // `SessionConfig.systemMessage` (append mode). Mirrors codex's
    // `buildCodexWorkspaceBootstrapContext` call in run-attempt.ts.
    // Failures here are non-fatal: workspace-bootstrap returns
    // `instructions: undefined` and the session proceeds without the
    // OpenClaw bootstrap block (SDK still loads AGENTS.md natively).
    const workspaceBootstrap = await resolveCopilotWorkspaceBootstrapContext({
      attempt: input,
      // Pair with `createSessionConfig`'s `workingDirectory:
      // effectiveWorkspaceDir` (round-8 [P1]) so bootstrap context
      // paths rendered into `SessionConfig.systemMessage` reflect
      // the sandbox copy when a `ro` / `none` sandbox redirected
      // the workspace. Without this remap the model would see
      // host-workspace paths while its native loader and bridged
      // tools all operate in the sandbox copy. Mirrors PI's
      // `remapInjectedContextFilesToWorkspace` call at
      // `src/agents/pi-embedded-runner/run/attempt.ts:1595`.
      effectiveWorkspaceDir,
      warn: (message) => console.warn(message),
    });
    const sessionConfig = createSessionConfig(
      input,
      modelRef.id,
      sdkTools,
      poolAcquire.auth,
      workspaceBootstrap.instructions,
      effectiveWorkspaceDir,
      effectiveCwd,
    );
    const replayDecision = decideReplayAction({
      sdkSessionId: input.initialReplayState?.sdkSessionId,
      replayInvalid: input.initialReplayState?.replayInvalid,
    });
    downgradedFromResume = replayDecision.downgradedFromResume;
    const resumeSessionId =
      replayDecision.action === "resume" ? replayDecision.sdkSessionId : undefined;

    // SAFETY: replay-shim owns the create/resume decision and the
    // recovery policy when resumeSession fails. See replay-shim.ts.
    // continuePendingWork is always false here so suspended tool/
    // permission work cannot be replayed implicitly — replay-shim's
    // worst-case-wins replayMetadata is the only signal the
    // orchestrator uses to decide whether the next attempt is safe.
    if (resumeSessionId) {
      try {
        session = (await client.resumeSession(resumeSessionId, {
          ...sessionConfig,
          continuePendingWork: false,
        })) as unknown as SessionLike;
      } catch (error: unknown) {
        const classification = classifyResumeFailure(error);
        if (!classification.recoverable) {
          throw error;
        }
        // Downgrade silently: the prior SDK session is gone, so start a
        // fresh one. replayMetadata will reflect replaySafe:false via
        // resumeFailureRecovered so the orchestrator does not blindly
        // retry the same prompt with stale assumptions.
        resumeFailureRecovered = true;
        session = (await client.createSession(sessionConfig)) as unknown as SessionLike;
      }
    } else {
      session = (await client.createSession(sessionConfig)) as unknown as SessionLike;
    }
    // Bind the session holder so the tool bridge's onYield callback
    // can abort the live SDK session if a wrapped tool yields.
    sessionRef.current = session;

    // After a recovered resume, the prior sdkSessionId no longer exists
    // server-side, so don't fall back to it: only the freshly-created
    // session's id is valid.
    sdkSessionId = readSessionId(session) ?? (resumeFailureRecovered ? undefined : resumeSessionId);
    sessionIdUsed = sdkSessionId ?? input.sessionId;
    if (sdkSessionId && deps.onSessionEstablished) {
      try {
        deps.onSessionEstablished({ sdkSessionId, pooledClient: handle, sessionConfig });
      } catch {
        // never let session-tracking callbacks break attempts
      }
    }
    bridge = attachEventBridge(session, {
      onAssistantDelta: input.onAssistantDelta,
      getSdkSessionId: () => sdkSessionId,
      isAborted: () => aborted,
    });

    const messageOptions = await createMessageOptions(input, {
      effectiveCwd,
      effectiveWorkspaceDir,
      sandbox,
      workspaceOnly: effectiveFsWorkspaceOnly,
    });
    if (abortRequested || params.abortSignal?.aborted) {
      aborted = true;
      externalAbort = true;
    } else {
      sentTurnStarted = true;
      const result = await session.sendAndWait(messageOptions, input.timeoutMs);
      await bridge.awaitDeltaChain();
      if (!bridge.recordSendResult(result) && !aborted) {
        // SDK sendAndWait returning undefined is treated as a timeout by the
        // capability inventory. Do not call session.abort() here: OpenClaw may
        // resume the in-flight SDK session on the next attempt.
        timedOut = true;
      }
      const snap = bridge.snapshot();
      if (!promptError && !timedOut && !aborted && snap.streamError) {
        promptError = snap.streamError;
      }
    }
  } catch (error: unknown) {
    if (!aborted) {
      if (isSdkSendAndWaitTimeoutError(error)) {
        // The SDK's sendAndWait timeout rejects with a deterministic
        // message but explicitly does NOT abort in-flight agent work
        // (see isSdkSendAndWaitTimeoutError docstring and
        // node_modules/@github/copilot-sdk/dist/session.js:156-164).
        // Mark timedOut so createResult's computeReplayMetadata flips
        // to side-effect-risky and the orchestrator's replay-shim can
        // decide whether to resume or restart. Do NOT call
        // session.abort() here: the orchestrator may resume the
        // in-flight SDK session on the next attempt (the SDK keeps
        // the server-side session intact across this kind of timeout).
        timedOut = true;
        // Flush any in-flight delta promise chain so the snapshot
        // built below in `finally` includes the deltas the SDK already
        // delivered before the timer fired.
        try {
          await bridge?.awaitDeltaChain();
        } catch {
          // delta-flush failure must not mask the timeout state
        }
      } else {
        promptError = toError(error);
      }
    }
  } finally {
    settled = true;
    bridge?.detach();
    params.abortSignal?.removeEventListener("abort", onAbort);

    if (session) {
      try {
        await session.disconnect();
      } catch (error: unknown) {
        disconnectError = toError(error);
        // A timeout is a higher-fidelity signal than a cleanup-time
        // disconnect failure; don't let a stale disconnect error
        // mask the timeout classification the replay-shim depends on.
        if (!promptError && !timedOut) {
          promptError = disconnectError;
        }
      }
    }

    if (handle) {
      try {
        await deps.pool.release(handle);
      } catch (error: unknown) {
        const releaseFailure = toError(error);
        if (promptError) {
          console.warn("[copilot-attempt] pool.release failed after primary error", releaseFailure);
        } else {
          releaseError = releaseFailure;
        }
      }
    }
  }

  if (releaseError) {
    throw releaseError;
  }

  const snap = bridge?.snapshot();
  const assistantTexts = bridge?.finalizeAssistantTexts() ?? [];
  const lastAssistant = bridge?.buildAssistantMessage({ modelRef, now });

  // Dogfood finding #3 (mirror codex parity):
  //
  // Without this synthesis the OpenClaw audit transcript never sees
  // the user's prompt for a copilot attempt. The shell's
  // `persistTextTurnTranscript` skips the user write when
  // `embeddedAssistantGapFill` is true (its `body` arrives as ""),
  // trusting the harness to mirror it. Codex does exactly this in
  // `event-projector.ts:262` by prepending
  // `{role:"user", content:params.prompt, ...}` tagged `${turnId}:prompt`.
  // We mirror that pattern with `${runId}:prompt` as the turn-stable
  // identity so re-mirror of the same turn is a true no-op AND two
  // turns sharing the same SDK session produce distinct dedupe keys
  // (the latter matters once session reuse lands in harness.ts).
  //
  // Defensive guard: if the caller already passed the same user turn
  // as the tail of `messages`, skip synthesis to avoid double-writing
  // the user message.
  const syntheticUserText = readString(input.transcriptPrompt) ?? readString(input.prompt);
  const tailUserText = readTailUserText(messages);
  const syntheticUser: AgentMessage | undefined =
    syntheticUserText && syntheticUserText !== tailUserText
      ? attachCopilotMirrorIdentity(
          { role: "user", content: syntheticUserText, timestamp: now() } as AgentMessage,
          `${input.runId}:prompt`,
        )
      : undefined;
  const taggedLastAssistant = lastAssistant
    ? attachCopilotMirrorIdentity(lastAssistant, `${input.runId}:assistant:final`)
    : undefined;
  const messagesSnapshot: AgentMessage[] = [
    ...messages,
    ...(syntheticUser ? [syntheticUser] : []),
    ...(taggedLastAssistant ? [taggedLastAssistant] : []),
  ];

  // Best-effort dual-write: mirror this attempt's full message snapshot
  // (user/assistant/toolResult) into the OpenClaw audit transcript at
  // params.sessionFile, alongside the SDK's own session storage. The
  // OpenClaw shell (attempt-execution.ts) writes only the user prompt
  // and terminal assistant text; mirroring here captures intermediate
  // tool calls/results for full audit/replay parity with the codex
  // extension. Identity-tagged so re-emits dedupe. Errors are
  // swallowed so a mirror failure cannot break the attempt.
  const sessionFileForMirror = readString(input.sessionFile);
  const sessionIdForScope = sessionIdUsed ?? readString(input.sessionId);
  if (sessionFileForMirror && messagesSnapshot.length > 0) {
    const taggedMessages = messagesSnapshot.map((message, index) => {
      if (
        message.role !== "user" &&
        message.role !== "assistant" &&
        message.role !== "toolResult"
      ) {
        return message;
      }
      // Preserve any caller-attached (or upstream-attached) mirror
      // identity — especially the `${runId}:prompt` /
      // `${runId}:assistant:final` identities attached above — so the
      // dedupe key stays turn-stable. Falling back to a per-attempt
      // positional identity here is only safe for messages that don't
      // already carry a logical identity; with SDK session reuse the
      // positional scheme would collapse turn 2's index-0 user onto
      // turn 1's index-0 user inside the same `${sdkSessionId}`
      // scope. See replay-shim.ts + harness.ts session-reuse path.
      if (hasMirrorIdentity(message)) {
        return message;
      }
      const identityScope = sdkSessionId ?? sessionIdForScope ?? "attempt";
      return attachCopilotMirrorIdentity(message, `${identityScope}:${message.role}:${index}`);
    });
    await dualWriteCopilotTranscriptBestEffort({
      sessionFile: sessionFileForMirror,
      sessionKey: readString((input as { sessionKey?: unknown }).sessionKey),
      agentId: readString(input.agentId),
      messages: taggedMessages,
      idempotencyScope: sessionIdForScope ? `copilot:${sessionIdForScope}` : undefined,
      config: (input as { config?: unknown }).config as never,
    }).catch((mirrorError: unknown) => {
      // Defense-in-depth: the best-effort wrapper already swallows
      // mirror failures, but we double-guard here so any future
      // signature change or unexpected rejection cannot break the
      // attempt result. The SDK's own session storage remains
      // authoritative; only the OpenClaw audit transcript would be
      // missing intermediate messages for this turn.
      console.warn(
        "[copilot-attempt] dual-write transcript wrapper rejected unexpectedly",
        mirrorError,
      );
    });
  }

  return createResult(input, {
    aborted,
    assistantTexts,
    currentAttemptAssistant: lastAssistant,
    downgradedFromResume,
    externalAbort,
    itemLifecycle: {
      activeCount: Math.max((snap?.startedCount ?? 0) - (snap?.completedCount ?? 0), 0),
      completedCount: snap?.completedCount ?? 0,
      startedCount: snap?.startedCount ?? 0,
    },
    lastAssistant,
    messagesSnapshot,
    now,
    promptError,
    resumeFailureRecovered,
    sdkSessionId,
    sessionIdUsed,
    timedOut,
    toolMetas: snap ? [...snap.toolMetas] : [],
    usage: snap?.usage,
    yieldDetected,
  });
}

function createResult(
  params: AttemptParamsLike,
  state: {
    aborted?: boolean;
    assistantTexts?: string[];
    currentAttemptAssistant?: AssistantMessage;
    downgradedFromResume?: boolean;
    externalAbort?: boolean;
    itemLifecycle?: { activeCount: number; completedCount: number; startedCount: number };
    lastAssistant?: AssistantMessage;
    messagesSnapshot: AgentMessage[];
    now: () => number;
    promptError: Error | undefined;
    resumeFailureRecovered?: boolean;
    sdkSessionId?: string;
    sessionIdUsed?: string;
    timedOut?: boolean;
    toolMetas?: Array<{ meta?: string; toolName: string }>;
    usage?: AssistantUsageSnapshot;
    yieldDetected?: boolean;
  },
): AttemptResultWithSdkSessionId {
  const promptError = state.promptError;
  const timedOut = state.timedOut === true;
  const toolMetas = state.toolMetas ?? [];
  const replayMetadata = computeReplayMetadata({
    priorReplayInvalid: params.initialReplayState?.replayInvalid,
    priorHadPotentialSideEffects: params.initialReplayState?.hadPotentialSideEffects,
    thisAttemptTimedOut: timedOut,
    thisAttemptHadPotentialSideEffects: copilotToolMetasHavePotentialSideEffects(toolMetas),
    thisAttemptDowngradedFromResume: state.downgradedFromResume,
    thisAttemptResumeFailureRecovered: state.resumeFailureRecovered,
  });
  return {
    aborted: state.aborted === true,
    ...(state.sdkSessionId ? { sdkSessionId: state.sdkSessionId } : {}),
    assistantTexts: state.assistantTexts ?? [],
    attemptUsage: state.usage,
    cloudCodeAssistFormatError: false,
    currentAttemptAssistant: state.currentAttemptAssistant,
    didSendViaMessagingTool: false,
    externalAbort: state.externalAbort === true,
    idleTimedOut: false,
    itemLifecycle: state.itemLifecycle ?? {
      activeCount: 0,
      completedCount: 0,
      startedCount: 0,
    },
    lastAssistant: state.lastAssistant,
    messagesSnapshot: state.messagesSnapshot,
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSentTexts: [],
    promptError,
    promptErrorSource: promptError ? "prompt" : null,
    replayMetadata,
    sessionFileUsed: readString(params.sessionFile),
    sessionIdUsed: state.sessionIdUsed ?? readString(params.sessionId) ?? "copilot-session",
    timedOut,
    timedOutDuringCompaction: false,
    toolMetas,
    yieldDetected: state.yieldDetected === true,
  };
}

function createPromptError(code: string, message: string, cause?: unknown): PromptErrorWithCode {
  const error = new Error(message) as PromptErrorWithCode;
  error.code = code;
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function createSessionConfig(
  params: AttemptParamsLike,
  sdkModelId: string,
  sdkTools: SdkTool[],
  resolvedAuth: ReturnType<typeof resolveCopilotAuth>,
  workspaceBootstrapInstructions: string | undefined,
  effectiveWorkspaceDir: string | undefined,
  effectiveCwd: string | undefined,
): CopilotSessionConfig {
  const permissionPolicy = params.permissionPolicy ?? rejectAllPolicy;
  const hooks = createHooksBridge(params.hooksConfig);
  const infiniteSessions = createInfiniteSessionConfig(params.infiniteSessionConfig);
  const systemMessageContent = createSystemMessageContent(params, workspaceBootstrapInstructions);
  return {
    model: sdkModelId,
    // Permission decisions for SDK built-in tool kinds (shell, write,
    // read, url, mcp, memory, hook) fall through to permission-bridge.
    // The default (`rejectAllPolicy`) keeps the harness fail-closed,
    // but the primary catalog restriction is `availableTools` below
    // (PR #86155 [P1] round-8): the SDK only exposes the exact set of
    // bridged tool names to the model, so native shell/read/write/url/
    // mcp/memory/hook tools never appear in the catalog and cannot be
    // invoked even under a permissive permission policy. The
    // permission-bridge stays in place as defense-in-depth for any
    // built-in kind that future SDK versions might surface outside
    // `availableTools`. Every bridged tool is also registered with
    // `overridesBuiltInTool: true` and `skipPermission: true` (see
    // tool-bridge.ts) so 100% of tool calls go through OpenClaw's
    // wrapped `execute()` which runs `runBeforeToolCallHook` (loop
    // detection, trusted plugin policies, before-tool-call hooks,
    // two-phase plugin approval). This mirrors the in-tree codex
    // harness's split: bridged-tool enforcement happens inside the
    // tool wrapper, and the SDK gate is a safety net for kinds we
    // don't surface. See permission-bridge.ts and docs/plugins/copilot.md.
    onPermissionRequest: createPermissionBridge(permissionPolicy),
    // `onUserInputRequest` is intentionally NOT registered: per the SDK
    // contract, omitting the handler hides the `ask_user` tool from the
    // model entirely. This is the MVP posture — interactive ask_user
    // requires routing the request to the OpenClaw channel/TUI prompt
    // path (mirroring extensions/codex/src/app-server/user-input-bridge.ts),
    // which is tracked as a follow-up. With the handler absent, agents
    // running under this harness must make best-judgment decisions from
    // the initial prompt rather than asking clarifying questions
    // mid-turn. See user-input-bridge.ts for the dormant policy
    // scaffolding the follow-up will reuse.
    // SessionHooks: only set when the host actually supplied handlers.
    // createHooksBridge returns undefined for an empty config so we
    // never install an empty hooks subsystem. See hooks-bridge.ts for
    // the back-pointer to src/agents/harness/lifecycle-hook-helpers.ts.
    ...(hooks ? { hooks } : {}),
    // Session-level telemetry opt-out: only propagate when the host
    // explicitly set a boolean. undefined means "use SDK default"
    // (enabled for GitHub auth; disabled when a BYOK provider is set).
    // Client-level OTel config is plumbed via runtime.ts /
    // telemetry-bridge.ts.
    ...(typeof params.enableSessionTelemetry === "boolean"
      ? { enableSessionTelemetry: params.enableSessionTelemetry }
      : {}),
    // Infinite sessions / background compaction: only attach when the
    // host provided an InfiniteSessionConfig. SDK defaults
    // (`enabled: true`, background 0.80, buffer 0.95) apply when
    // omitted. See compaction-bridge.ts.
    ...(infiniteSessions ? { infiniteSessions } : {}),
    reasoningEffort: params.reasoningEffort,
    tools: sdkTools,
    // Restrict the SDK's tool catalog to exactly the bridged tool names
    // returned by `createCopilotToolBridge`. Without this, the SDK
    // would still expose its native read/write/shell/url/mcp/memory/
    // hook tools to the model alongside our overrides, which would
    // bypass OpenClaw's wrapped-tool enforcement under any permissive
    // permission policy and pollute the catalog with disabled tools
    // under the default reject policy. An empty list (`[]`) is
    // meaningful per the SDK contract
    // (`@github/copilot-sdk/dist/types.d.ts:1059-1061`): when set,
    // only the listed tools are available. Derived inside this
    // function (not passed as a parameter) so create/resume always
    // stay coupled to the registered external `tools` array. See PR
    // #86155 [P1] round-8 and ResumeSessionConfig at
    // `@github/copilot-sdk/dist/types.d.ts:1198` (it picks
    // `availableTools`, so the spread into `resumeSession` covers
    // the resume path too).
    availableTools: sdkTools.map((tool) => tool.name),
    workingDirectory:
      effectiveCwd ?? effectiveWorkspaceDir ?? readResolvedAttemptPath(params.workspaceDir),
    // When a task runs from a sub-cwd, keep SDK-native project docs
    // (AGENTS.md, .github/copilot-instructions.md) visible from the
    // canonical workspace too; workspace-bootstrap filters AGENTS.md
    // because the SDK owns those instruction files.
    ...(effectiveWorkspaceDir && effectiveCwd && effectiveCwd !== effectiveWorkspaceDir
      ? { instructionDirectories: [effectiveWorkspaceDir] }
      : {}),
    // Session-level GitHub token. INDEPENDENT of the client-level
    // token in `CopilotClientOptions.gitHubToken` (set in
    // `resolvePoolAcquire().options`). Per the SDK contract
    // (`@github/copilot-sdk/dist/types.d.ts:1168-1178`), the client-
    // level token authenticates the CLI process while the session-
    // level token determines the identity used for content exclusion,
    // model routing, and quota — and is sent on BOTH `createSession`
    // and `resumeSession` (`ResumeSessionConfig` picks `gitHubToken`
    // at types.d.ts:1198). Omitted when `useLoggedInUser` is the
    // resolved mode — passing both would be contradictory and the SDK
    // already implies content-exclusion/quota from the logged-in
    // identity in that mode.
    ...(resolvedAuth.authMode === "gitHubToken" && resolvedAuth.gitHubToken
      ? { gitHubToken: resolvedAuth.gitHubToken }
      : {}),
    // OpenClaw workspace bootstrap plus per-turn runtime guidance
    // injected via the SDK's `systemMessage` field in append mode:
    // SDK foundation + OpenClaw context. Append keeps every SDK
    // guardrail intact while ensuring persona/identity/heartbeat and
    // channel policy guidance reach the model without native reads.
    // AGENTS.md and .github/copilot-instructions.md are filtered by
    // workspace-bootstrap.ts because the SDK auto-loads them from
    // `workingDirectory` (see `@github/copilot-sdk/dist/types.d.ts`
    // L1036). Omitted when there is no OpenClaw-owned context so the
    // SDK default foundation applies.
    ...(systemMessageContent
      ? {
          systemMessage: {
            mode: "append" as const,
            content: systemMessageContent,
          },
        }
      : {}),
  };
}

async function createMessageOptions(
  params: AttemptParamsLike,
  context: {
    effectiveCwd: string | undefined;
    effectiveWorkspaceDir: string | undefined;
    sandbox: SandboxContext | null;
    workspaceOnly: boolean;
  },
): Promise<MessageOptions> {
  const attachments = createPromptImageAttachments(await resolvePromptImages(params, context));
  return attachments.length > 0
    ? { prompt: params.prompt, attachments }
    : { prompt: params.prompt };
}

function createPromptImageAttachments(
  images: unknown[],
): NonNullable<MessageOptions["attachments"]> {
  return images.flatMap((image, index) => {
    if (
      !image ||
      typeof image !== "object" ||
      (image as { type?: unknown }).type !== "image" ||
      typeof (image as { data?: unknown }).data !== "string" ||
      typeof (image as { mimeType?: unknown }).mimeType !== "string"
    ) {
      return [];
    }
    return [
      {
        type: "blob" as const,
        data: (image as { data: string }).data,
        mimeType: (image as { mimeType: string }).mimeType,
        displayName: `prompt-image-${index + 1}`,
      },
    ];
  });
}

async function resolvePromptImages(
  params: AttemptParamsLike,
  context: {
    effectiveCwd: string | undefined;
    effectiveWorkspaceDir: string | undefined;
    sandbox: SandboxContext | null;
    workspaceOnly: boolean;
  },
): Promise<unknown[]> {
  const workspaceDir =
    context.effectiveCwd ??
    context.effectiveWorkspaceDir ??
    readResolvedAttemptPath(params.cwd) ??
    readResolvedAttemptPath(params.workspaceDir);
  if (!workspaceDir) {
    return [];
  }
  const localRoots =
    context.workspaceOnly && context.effectiveWorkspaceDir
      ? [context.effectiveWorkspaceDir]
      : undefined;
  const result = await detectAndLoadAgentHarnessPromptImages({
    prompt: params.prompt,
    workspaceDir,
    model: resolveImageCapabilityModel(params),
    existingImages: Array.isArray(params.images) ? params.images : undefined,
    imageOrder: Array.isArray(params.imageOrder) ? params.imageOrder : undefined,
    config: params.config,
    workspaceOnly: context.workspaceOnly,
    localRoots,
    sandbox:
      context.sandbox?.enabled && context.sandbox.fsBridge
        ? { root: context.sandbox.workspaceDir, bridge: context.sandbox.fsBridge }
        : undefined,
  });
  return result.images;
}

function resolveImageCapabilityModel(params: AttemptParamsLike): { input?: string[] } {
  const model = params.model;
  if (model && typeof model === "object" && Array.isArray((model as { input?: unknown }).input)) {
    return { input: (model as { input: string[] }).input };
  }
  return { input: ["image"] };
}

function createSystemMessageContent(
  params: AttemptParamsLike,
  workspaceBootstrapInstructions: string | undefined,
): string | undefined {
  const sections: string[] = [];
  const bootstrap = workspaceBootstrapInstructions?.trim();
  if (bootstrap) {
    sections.push(bootstrap);
  }
  const extraSystemPrompt = readString(params.extraSystemPrompt)?.trim();
  if (extraSystemPrompt && !isRawCopilotModelRun(params)) {
    const contextHeader =
      params.promptMode === "minimal" ? "## Subagent Context" : "## Group Chat Context";
    sections.push(`${contextHeader}\n${extraSystemPrompt}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function isRawCopilotModelRun(params: AttemptParamsLike): boolean {
  return params.modelRun === true || params.promptMode === "none";
}

function getMessagesSnapshotInput(params: AttemptParamsLike): AgentMessage[] {
  return Array.isArray(params.messages) ? [...params.messages] : [];
}

// Returns the trimmed plain-text content of the tail user message in
// `messages`, if any. Used to skip synthetic-user injection when the
// caller already passed the current turn's user prompt as the last
// entry of `params.messages`, which would otherwise produce a duplicate
// user record in the audit transcript.
function readTailUserText(messages: AgentMessage[]): string | undefined {
  const tail = messages[messages.length - 1];
  if (!tail || tail.role !== "user") {
    return undefined;
  }
  const content = (tail as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) {
          return text;
        }
      }
    }
  }
  return undefined;
}

// True when an AgentMessage already carries a stable mirror identity
// (e.g. the `${runId}:prompt` / `${runId}:assistant:final` identities
// attached in attempt.ts before the dual-write, or any caller-attached
// identity from a prior turn). Keep this in sync with the
// MIRROR_IDENTITY_META_KEY constant in dual-write-transcripts.ts; we
// duplicate the read here instead of importing the helper to avoid
// widening the module's public surface for what is otherwise a pure
// guard. See attempt.ts dual-write tagging block.
function hasMirrorIdentity(message: AgentMessage): boolean {
  const record = message as unknown as { __openclaw?: unknown };
  const meta = record["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return false;
  }
  const id = (meta as Record<string, unknown>).mirrorIdentity;
  return typeof id === "string" && id.length > 0;
}

function readSessionId(session: SessionLike | undefined): string | undefined {
  if (!session) {
    return undefined;
  }
  return readString(session.sessionId) ?? readString(session.id);
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readResolvedAttemptPath(value: unknown): string | undefined {
  const raw = readString(value)?.trim();
  if (!raw) {
    return undefined;
  }
  if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(raw)) {
    return raw;
  }
  return resolveUserPath(raw);
}

export function resolveModelRef(params: AttemptParamsLike): ModelRef {
  const rawModel = params.model;
  if (rawModel && typeof rawModel === "object") {
    return {
      api: readString(rawModel.api),
      id:
        readString(rawModel.id) ??
        readString((params as { modelId?: unknown }).modelId) ??
        "unknown-model",
      provider:
        readString(rawModel.provider) ??
        readString((params as { provider?: unknown }).provider) ??
        "unknown-provider",
    };
  }
  return {
    id:
      readString(typeof rawModel === "string" ? rawModel : undefined) ??
      readString((params as { modelId?: unknown }).modelId) ??
      "unknown-model",
    provider: readString((params as { provider?: unknown }).provider) ?? "unknown-provider",
  };
}

export function resolvePoolAcquire(params: AttemptParamsLike): {
  key: PoolKey;
  options: ClientCreateOptions;
  /**
   * The resolved auth result is returned so call sites that build a
   * `SessionConfig` immediately afterwards (attempt.ts +
   * side-question.ts) can populate `SessionConfig.gitHubToken`
   * without re-resolving auth. `SessionConfig.gitHubToken` is
   * INDEPENDENT of `CopilotClientOptions.gitHubToken` per the SDK
   * contract (`@github/copilot-sdk/dist/types.d.ts:1168-1178`): the
   * client-level token authenticates the CLI process, while the
   * session-level token determines the identity used for content
   * exclusion, model routing, and quota. Both `createSession` and
   * `resumeSession` (`ResumeSessionConfig` at types.d.ts:1198) honor
   * the session-level field, so per-session multitenancy requires
   * setting both.
   */
  auth: ReturnType<typeof resolveCopilotAuth>;
} {
  const resolved = resolveCopilotAuth({
    agentId: readString(params.agentId),
    agentDir: readString(params.agentDir),
    workspaceDir: readString(params.workspaceDir),
    copilotHome: readString(params.copilotHome),
    auth: params.auth,
    // Contract-resolved auth (EmbeddedRunAttemptParams): the production
    // main path for agents with a configured `github-copilot` auth
    // profile. Falling through to env / useLoggedInUser when absent
    // keeps the direct-CLI / dogfood paths working unchanged.
    resolvedApiKey: readString(params.resolvedApiKey),
    authProfileId: readString(params.authProfileId),
    profileVersion: readString(params.profileVersion),
  });

  return {
    key: {
      agentId: resolved.agentId,
      authMode: resolved.authMode,
      ...(resolved.authMode === "gitHubToken"
        ? {
            authProfileId: resolved.authProfileId,
            authProfileVersion: resolved.authProfileVersion,
          }
        : {}),
      copilotHome: resolved.copilotHome,
    },
    options: {
      copilotHome: resolved.copilotHome,
      gitHubToken: resolved.authMode === "gitHubToken" ? resolved.gitHubToken : undefined,
      useLoggedInUser: resolved.authMode === "useLoggedInUser",
    },
    auth: resolved,
  };
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Detect the @github/copilot-sdk `session.sendAndWait` timeout
 * rejection shape. The SDK's `sendAndWait` races the internal
 * `session.idle` event against a timer; when the timer fires first
 * it REJECTS the promise with
 * `new Error(`Timeout after ${effectiveTimeout}ms waiting for
 * session.idle`)` (see
 * `node_modules/@github/copilot-sdk/dist/session.js:156-164`), and
 * the SDK docs explicitly note the timeout "does not abort in-flight
 * agent work". The caller is therefore responsible for setting the
 * timed-out state and (for paths where in-flight work should be
 * stopped) calling `session.abort()`.
 *
 * Keep the regex anchored and narrow so unrelated errors that happen
 * to mention "Timeout" are NOT mis-classified. The shape is a literal
 * template-string concatenation in the 1.0.0-beta line; a minor
 * version bump that changes the wording will safely fall through to
 * the generic prompt-error path.
 */
export function isSdkSendAndWaitTimeoutError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== "string") {
    return false;
  }
  return /^Timeout after \d+ms waiting for session\.idle$/.test(message);
}
