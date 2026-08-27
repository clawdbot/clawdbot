import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { manualTranscriptSourceProvider } from "../../transcripts/manual-source.js";
import { getTranscriptSourceProvider } from "../../transcripts/provider-registry.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptSourceLocator,
  TranscriptSourceProvider,
  TranscriptToolAction,
  TranscriptToolCaller,
  TranscriptsStartResult,
} from "../../transcripts/provider-types.js";
import { sanitizeTranscriptSourceLocator } from "../../transcripts/source-locator.js";
import type { TranscriptsStore } from "../../transcripts/store.js";
import { truncateUtf16Safe } from "../../utils.js";

const ACCOUNT_ID_OUTPUT_MAX_CHARS = 64;

function formatAccountIdForToolText(accountId: string): string {
  return JSON.stringify(truncateUtf16Safe(accountId, ACCOUNT_ID_OUTPUT_MAX_CHARS));
}

export type TranscriptsLogger = {
  warn: (message: string) => void;
};

export type TranscriptsRuntimeContext = {
  agentId?: string;
  agentChannel?: string;
  agentAccountId?: string;
  caller?: TranscriptToolCaller;
  assertCallerActive?: () => void;
  config?: OpenClawConfig;
  stateDir: string;
  logger: TranscriptsLogger;
};

type ActiveTranscriptsSession = {
  session: TranscriptSessionDescriptor;
  providerId: string;
  // Durable timestamps can collide; lifecycle cleanup must match this exact process-owned capture.
  lifecycleToken?: symbol;
  // Keep the capture reserved until provider and durable stop work both finish.
  stopToken?: symbol;
  // Aborted starts stay active until a later stop confirms provider cleanup.
  cleanupPending?: true;
};

// Process-local ownership shared by tool-driven and configured transcript captures.
export const activeSessions = new Map<string, ActiveTranscriptsSession>();
// Reserve ids across async provider startup so overlapping starts cannot
// replace the only cleanup owner for an existing or still-starting capture.
const startingSessionIds = new Set<string>();

function createStartupAbortScope(parent?: AbortSignal): {
  signal?: AbortSignal;
  detach: () => void;
} {
  if (!parent) {
    return { signal: undefined, detach: () => {} };
  }
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent.reason);
  if (parent.aborted) {
    abortFromParent();
  } else {
    parent.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    // Provider startup owns this scoped signal only until start settles.
    // Detaching prevents a later agent-run abort from ending live capture.
    detach: () => parent.removeEventListener("abort", abortFromParent),
  };
}

export function readTranscriptStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required: true; trim?: boolean },
): string;
export function readTranscriptStringParam(
  params: Record<string, unknown>,
  key: string,
  options?: { required?: false; trim?: boolean },
): string | undefined;
export function readTranscriptStringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; trim?: boolean } = {},
): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    if (options.required) {
      throw new Error(`${key} required`);
    }
    return undefined;
  }
  const normalized = options.trim === false ? value : value.trim();
  if (!normalized && options.required) {
    throw new Error(`${key} required`);
  }
  return normalized || undefined;
}

export function createTranscriptSessionId(): string {
  return `transcript-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

// Provider routing comes from tool params so manual imports and live providers
// share one persisted source descriptor.
export function sourceFromParams(params: Record<string, unknown>): TranscriptSourceLocator {
  const providerId =
    readTranscriptStringParam(params, "providerId", { trim: true }) ?? "manual-transcript";
  return {
    providerId,
    accountId: readTranscriptStringParam(params, "accountId", { trim: true }),
    guildId: readTranscriptStringParam(params, "guildId", { trim: true }),
    channelId: readTranscriptStringParam(params, "channelId", { trim: true }),
    meetingUrl: readTranscriptStringParam(params, "meetingUrl", { trim: true }),
  };
}

export function resolveSourceProvider(providerId: string, ctx: TranscriptsRuntimeContext) {
  return providerId === manualTranscriptSourceProvider.id
    ? manualTranscriptSourceProvider
    : getTranscriptSourceProvider(providerId, ctx.config);
}

function bindSourceToTurnAccount(params: {
  ctx: TranscriptsRuntimeContext;
  operation: "import" | "start";
  provider: TranscriptSourceProvider;
  source: TranscriptSourceLocator;
}): {
  source: TranscriptSourceLocator;
} {
  const ownership = params.provider.accessControl;
  if (!ownership) {
    return { source: params.source };
  }
  if (params.ctx.caller?.kind === "operator") {
    return { source: params.source };
  }
  const ownerChannel = ownership.channelId.trim().toLowerCase();
  if (!ownerChannel) {
    throw new Error(
      `transcripts provider ${params.provider.id} has an invalid account owner channel`,
    );
  }
  const channel = params.ctx.caller?.channel?.trim().toLowerCase();
  const accountId = params.ctx.caller?.accountId?.trim();
  if (!channel) {
    return { source: params.source };
  }
  if (channel !== ownerChannel) {
    throw new Error(
      `transcripts provider ${params.provider.id} can only ${params.operation} from ${ownerChannel} or a channel-less local tool`,
    );
  }
  if (!accountId) {
    throw new Error(
      `transcripts provider ${params.provider.id} requires trusted account context from ${channel}`,
    );
  }
  // Same-channel capture stays on the trusted inbound account; model input
  // cannot redirect or later control another configured channel account.
  return {
    source: { ...params.source, accountId },
  };
}

export async function authorizeTranscriptSource(params: {
  action: TranscriptToolAction;
  ctx: TranscriptsRuntimeContext;
  provider: TranscriptSourceProvider;
  source: TranscriptSourceLocator;
}): Promise<void> {
  params.ctx.assertCallerActive?.();
  const ownership = params.provider.accessControl;
  if (!ownership) {
    return;
  }
  const caller = params.ctx.caller;
  if (!caller) {
    throw new Error("transcripts caller authorization is unavailable");
  }
  const authorization = await ownership.authorize({
    action: params.action,
    caller,
    cfg: params.ctx.config,
    source: params.source,
  });
  params.ctx.assertCallerActive?.();
  if (!authorization.ok) {
    throw new Error(authorization.error);
  }
}

export function resolveTranscriptSourceOwnership(params: {
  ctx: TranscriptsRuntimeContext;
  operation: "import" | "start";
  provider: TranscriptSourceProvider;
  source: TranscriptSourceLocator;
  configuredLifecycle?: boolean;
}): {
  source: TranscriptSourceLocator;
} {
  const boundSource = bindSourceToTurnAccount(params);
  const ownership = params.provider.accessControl;
  const trustedAccountId =
    ownership && params.ctx.caller?.kind === "channel"
      ? params.ctx.caller.accountId?.trim()
      : undefined;
  const sourceForResolution = trustedAccountId
    ? { ...boundSource.source, accountId: trustedAccountId }
    : boundSource.source;
  const accountResolution = ownership?.resolveAccountId({
    cfg: params.ctx.config,
    source: sourceForResolution,
  });
  if (accountResolution && !accountResolution.ok) {
    throw new Error(accountResolution.error);
  }
  const resolvedAccountId = accountResolution
    ? accountResolution.value?.trim()
    : sourceForResolution.accountId?.trim();
  if (trustedAccountId && resolvedAccountId !== trustedAccountId) {
    throw new Error(
      `transcripts provider ${params.provider.id} could not use trusted account ${formatAccountIdForToolText(trustedAccountId)}`,
    );
  }
  const providerSource = ownership
    ? { ...sourceForResolution, accountId: resolvedAccountId }
    : sourceForResolution;
  if (params.configuredLifecycle && ownership && !providerSource.accountId?.trim()) {
    throw new Error(
      `transcripts provider ${params.provider.id} could not resolve an account for configured auto-start`,
    );
  }
  return { source: providerSource };
}

export function toolText(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details: details ?? {},
  };
}

export async function stopPendingTranscriptCapture(params: {
  ctx: TranscriptsRuntimeContext;
  provider: TranscriptSourceProvider | undefined;
  session: TranscriptSessionDescriptor;
  reason: string;
}): Promise<string | undefined> {
  if (!params.provider?.stop) {
    return `transcripts provider ${params.session.source.providerId} cannot stop live capture`;
  }
  try {
    const result = await params.provider.stop({
      cfg: params.ctx.config,
      sessionId: params.session.sessionId,
      source: params.session.source,
      reason: params.reason,
    });
    return result.ok ? undefined : result.error;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function startTranscripts(params: {
  ctx: TranscriptsRuntimeContext;
  store: TranscriptsStore;
  rawParams: Record<string, unknown>;
  abortSignal?: AbortSignal;
  startupWaitMs?: number;
  configuredLifecycle?: true;
  lifecycleToken?: symbol;
}) {
  if (params.abortSignal?.aborted) {
    throw new Error("transcripts start aborted");
  }
  const requestedSource = {
    ...sourceFromParams(params.rawParams),
    ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
  };
  const provider = resolveSourceProvider(requestedSource.providerId, params.ctx);
  if (!provider?.start) {
    throw new Error(`transcripts provider ${requestedSource.providerId} cannot start live capture`);
  }
  const resolvedSource = resolveTranscriptSourceOwnership({
    ctx: params.ctx,
    operation: "start",
    provider,
    source: requestedSource,
    configuredLifecycle: params.configuredLifecycle,
  });
  const providerSource = resolvedSource.source;
  if (!params.configuredLifecycle) {
    await authorizeTranscriptSource({
      action: "start",
      ctx: params.ctx,
      provider,
      source: providerSource,
    });
  }
  const session: TranscriptSessionDescriptor = {
    sessionId:
      readTranscriptStringParam(params.rawParams, "sessionId", { trim: true }) ??
      createTranscriptSessionId(),
    title: readTranscriptStringParam(params.rawParams, "title", { trim: true }),
    source: sanitizeTranscriptSourceLocator(providerSource),
    startedAt: new Date().toISOString(),
    metadata: params.ctx.agentId ? { agentId: params.ctx.agentId } : {},
  };
  if (activeSessions.has(session.sessionId) || startingSessionIds.has(session.sessionId)) {
    throw new Error(`transcripts session already active: ${session.sessionId}`);
  }
  startingSessionIds.add(session.sessionId);
  try {
    await params.store.writeSession(session);
    let startupPending = true;
    const startupAbort = createStartupAbortScope(params.abortSignal);
    let result: TranscriptsStartResult;
    try {
      result = await provider.start({
        cfg: params.ctx.config,
        session: { ...session, source: providerSource },
        abortSignal: startupAbort.signal,
        startupWaitMs: params.startupWaitMs,
        onUtterance: async (utterance) => {
          // Provider callbacks can race abort cleanup; never persist that late startup audio.
          if (startupPending && startupAbort.signal?.aborted) {
            return;
          }
          await params.store.appendUtteranceForSession(session, utterance);
        },
      });
    } finally {
      startupAbort.detach();
    }
    // Provider failures retain cleanup ownership; only a successful result can
    // transfer a live capture to this lifecycle for abort/stop retry handling.
    if (!result.ok) {
      throw new Error(result.error);
    }
    if (startupAbort.signal?.aborted) {
      const cleanupError = await stopPendingTranscriptCapture({
        ctx: params.ctx,
        provider,
        session,
        reason: "service-stop",
      });
      if (cleanupError) {
        activeSessions.set(session.sessionId, {
          session,
          providerId: provider.id,
          cleanupPending: true,
          ...(params.lifecycleToken ? { lifecycleToken: params.lifecycleToken } : {}),
        });
        throw new Error(`transcripts start aborted; provider cleanup failed: ${cleanupError}`);
      }
      throw new Error("transcripts start aborted");
    }
    startupPending = false;
    activeSessions.set(session.sessionId, {
      session,
      providerId: provider.id,
      ...(params.lifecycleToken ? { lifecycleToken: params.lifecycleToken } : {}),
    });
    const effectiveAccount = session.source.accountId;
    return toolText(
      `Transcripts started: ${session.sessionId}${effectiveAccount ? `\nAccount: ${formatAccountIdForToolText(effectiveAccount)}` : ""}`,
      {
        sessionId: session.sessionId,
        startedAt: session.startedAt,
        providerId: provider.id,
        ...(effectiveAccount ? { accountId: effectiveAccount } : {}),
      },
    );
  } finally {
    startingSessionIds.delete(session.sessionId);
  }
}
