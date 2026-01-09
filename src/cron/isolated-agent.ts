import crypto from "node:crypto";
import { runCliAgent } from "../agents/cli-runner.js";
import { getCliSessionId, setCliSessionId } from "../agents/cli-session.js";
import { lookupContextTokens } from "../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runWithModelFallback } from "../agents/model-fallback.js";
import {
  getModelRefStatus,
  isCliProvider,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
  resolveThinkingDefault,
} from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { buildWorkspaceSkillSnapshot } from "../agents/skills.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { hasNonzeroUsage } from "../agents/usage.js";
import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  ensureAgentWorkspace,
} from "../agents/workspace.js";
import {
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  stripHeartbeatToken,
} from "../auto-reply/heartbeat.js";
import { normalizeThinkLevel } from "../auto-reply/thinking.js";
import type { CliDeps } from "../cli/deps.js";
import type { ClawdbotConfig } from "../config/config.js";
import {
  DEFAULT_IDLE_MINUTES,
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveMainSessionKey,
  resolveSessionTranscriptPath,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import { registerAgentRunContext } from "../infra/agent-events.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { resolveMessageProviderSelection } from "../infra/outbound/provider-selection.js";
import { resolveOutboundTarget, type OutboundProvider } from "../infra/outbound/targets.js";
import { normalizeProviderId } from "../providers/plugins/index.js";
import type { ProviderId } from "../providers/plugins/types.js";
import { DEFAULT_CHAT_PROVIDER } from "../providers/registry.js";
import { normalizeMessageProvider } from "../utils/message-provider.js";
import { truncateUtf16Safe } from "../utils.js";
import type { CronJob } from "./types.js";

export type RunCronAgentTurnResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
};

type DeliveryPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};

function pickSummaryFromOutput(text: string | undefined) {
  const clean = (text ?? "").trim();
  if (!clean) return undefined;
  const limit = 2000;
  return clean.length > limit ? `${truncateUtf16Safe(clean, limit)}…` : clean;
}

function pickSummaryFromPayloads(
  payloads: Array<{ text?: string | undefined }>,
) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) return summary;
  }
  return undefined;
}

/**
 * Check if all payloads are just heartbeat ack responses (HEARTBEAT_OK).
 * Returns true if delivery should be skipped because there's no real content.
 */
function isHeartbeatOnlyResponse(
  payloads: DeliveryPayload[],
  ackMaxChars: number,
) {
  if (payloads.length === 0) return true;
  return payloads.every((payload) => {
    // If there's media, we should deliver regardless of text content.
    const hasMedia =
      (payload.mediaUrls?.length ?? 0) > 0 || Boolean(payload.mediaUrl);
    if (hasMedia) return false;
    // Use heartbeat mode to check if text is just HEARTBEAT_OK or short ack.
    const result = stripHeartbeatToken(payload.text, {
      mode: "heartbeat",
      maxAckChars: ackMaxChars,
    });
    return result.shouldSkip;
  });
}

async function resolveDeliveryTarget(
  cfg: ClawdbotConfig,
  jobPayload: {
    provider?: "last" | ProviderId;
    to?: string;
  },
): Promise<{
  provider: string;
  to?: string;
  accountId?: string;
  mode: "explicit" | "implicit";
  error?: Error;
}> {
  const requestedRaw =
    typeof jobPayload.provider === "string" ? jobPayload.provider : "last";
  const requestedProvider = normalizeMessageProvider(requestedRaw) ?? requestedRaw;
  const explicitTo =
    typeof jobPayload.to === "string" && jobPayload.to.trim()
      ? jobPayload.to.trim()
      : undefined;

  const sessionCfg = cfg.session;
  const mainSessionKey = resolveMainSessionKey(cfg);
  const agentId = resolveAgentIdFromSessionKey(mainSessionKey);
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const main = store[mainSessionKey];
  const lastProvider =
    main?.lastProvider && main.lastProvider !== "webchat"
      ? normalizeProviderId(main.lastProvider) ?? main.lastProvider
      : undefined;
  const lastTo = typeof main?.lastTo === "string" ? main.lastTo.trim() : "";
  const lastAccountId = main?.lastAccountId;

  let provider =
    requestedProvider === "last"
      ? lastProvider
      : requestedProvider === "webchat"
        ? undefined
        : normalizeProviderId(requestedProvider);
  if (!provider) {
    try {
      const selection = await resolveMessageProviderSelection({ cfg });
      provider = selection.provider;
    } catch {
      provider = lastProvider ?? DEFAULT_CHAT_PROVIDER;
    }
  }

  const toCandidate = explicitTo ?? (lastTo || undefined);
  const mode: "explicit" | "implicit" = explicitTo ? "explicit" : "implicit";
  if (!toCandidate) {
    return { provider, to: undefined, accountId: lastAccountId, mode };
  }

  const resolved = resolveOutboundTarget({
    provider: provider as Exclude<OutboundProvider, "none">,
    to: toCandidate,
    cfg,
    accountId: provider === lastProvider ? lastAccountId : undefined,
    mode,
  });
  return {
    provider,
    to: resolved.ok ? resolved.to : undefined,
    accountId: provider === lastProvider ? lastAccountId : undefined,
    mode,
    error: resolved.ok ? undefined : resolved.error,
  };
}

function resolveCronSession(params: {
  cfg: ClawdbotConfig;
  sessionKey: string;
  nowMs: number;
}) {
  const sessionCfg = params.cfg.session;
  const idleMinutes = Math.max(
    sessionCfg?.idleMinutes ?? DEFAULT_IDLE_MINUTES,
    1,
  );
  const idleMs = idleMinutes * 60_000;
  const storePath = resolveStorePath(sessionCfg?.store);
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  const fresh = entry && params.nowMs - entry.updatedAt <= idleMs;
  const sessionId = fresh ? entry.sessionId : crypto.randomUUID();
  const systemSent = fresh ? Boolean(entry.systemSent) : false;
  const sessionEntry: SessionEntry = {
    sessionId,
    updatedAt: params.nowMs,
    systemSent,
    thinkingLevel: entry?.thinkingLevel,
    verboseLevel: entry?.verboseLevel,
    model: entry?.model,
    contextTokens: entry?.contextTokens,
    sendPolicy: entry?.sendPolicy,
    lastProvider: entry?.lastProvider,
    lastTo: entry?.lastTo,
  };
  return { storePath, store, sessionEntry, systemSent, isNewSession: !fresh };
}

export async function runCronIsolatedAgentTurn(params: {
  cfg: ClawdbotConfig;
  deps: CliDeps;
  job: CronJob;
  message: string;
  sessionKey: string;
  lane?: string;
}): Promise<RunCronAgentTurnResult> {
  const agentCfg = params.cfg.agents?.defaults;
  const workspaceDirRaw = agentCfg?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
  });
  const workspaceDir = workspace.dir;

  const resolvedDefault = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  let provider = resolvedDefault.provider;
  let model = resolvedDefault.model;
  let catalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  const loadCatalog = async () => {
    if (!catalog) {
      catalog = await loadModelCatalog({ config: params.cfg });
    }
    return catalog;
  };
  // Resolve model - prefer hooks.gmail.model for Gmail hooks.
  const isGmailHook = params.sessionKey.startsWith("hook:gmail:");
  const hooksGmailModelRef = isGmailHook
    ? resolveHooksGmailModel({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
      })
    : null;
  if (hooksGmailModelRef) {
    const status = getModelRefStatus({
      cfg: params.cfg,
      catalog: await loadCatalog(),
      ref: hooksGmailModelRef,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if (status.allowed) {
      provider = hooksGmailModelRef.provider;
      model = hooksGmailModelRef.model;
    }
  }
  const modelOverrideRaw =
    params.job.payload.kind === "agentTurn"
      ? params.job.payload.model
      : undefined;
  if (modelOverrideRaw !== undefined) {
    if (typeof modelOverrideRaw !== "string") {
      return { status: "error", error: "invalid model: expected string" };
    }
    const resolvedOverride = resolveAllowedModelRef({
      cfg: params.cfg,
      catalog: await loadCatalog(),
      raw: modelOverrideRaw,
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    if ("error" in resolvedOverride) {
      return { status: "error", error: resolvedOverride.error };
    }
    provider = resolvedOverride.ref.provider;
    model = resolvedOverride.ref.model;
  }
  const now = Date.now();
  const cronSession = resolveCronSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    nowMs: now,
  });
  const isFirstTurnInSession =
    cronSession.isNewSession || !cronSession.systemSent;

  // Resolve thinking level - job thinking > hooks.gmail.thinking > agent default
  const hooksGmailThinking = isGmailHook
    ? normalizeThinkLevel(params.cfg.hooks?.gmail?.thinking)
    : undefined;
  const thinkOverride = normalizeThinkLevel(agentCfg?.thinkingDefault);
  const jobThink = normalizeThinkLevel(
    (params.job.payload.kind === "agentTurn"
      ? params.job.payload.thinking
      : undefined) ?? undefined,
  );
  let thinkLevel = jobThink ?? hooksGmailThinking ?? thinkOverride;
  if (!thinkLevel) {
    thinkLevel = resolveThinkingDefault({
      cfg: params.cfg,
      provider,
      model,
      catalog: await loadCatalog(),
    });
  }

  const timeoutMs = resolveAgentTimeoutMs({
    cfg: params.cfg,
    overrideSeconds:
      params.job.payload.kind === "agentTurn"
        ? params.job.payload.timeoutSeconds
        : undefined,
  });

  const delivery =
    params.job.payload.kind === "agentTurn" &&
    params.job.payload.deliver === true;
  const bestEffortDeliver =
    params.job.payload.kind === "agentTurn" &&
    params.job.payload.bestEffortDeliver === true;

  const resolvedDelivery = await resolveDeliveryTarget(params.cfg, {
    provider:
      params.job.payload.kind === "agentTurn"
        ? params.job.payload.provider
        : "last",
    to:
      params.job.payload.kind === "agentTurn"
        ? params.job.payload.to
        : undefined,
  });

  const base =
    `[cron:${params.job.id} ${params.job.name}] ${params.message}`.trim();

  const commandBody = base;

  const needsSkillsSnapshot =
    cronSession.isNewSession || !cronSession.sessionEntry.skillsSnapshot;
  const skillsSnapshot = needsSkillsSnapshot
    ? buildWorkspaceSkillSnapshot(workspaceDir, { config: params.cfg })
    : cronSession.sessionEntry.skillsSnapshot;
  if (needsSkillsSnapshot && skillsSnapshot) {
    cronSession.sessionEntry = {
      ...cronSession.sessionEntry,
      updatedAt: Date.now(),
      skillsSnapshot,
    };
    cronSession.store[params.sessionKey] = cronSession.sessionEntry;
    await saveSessionStore(cronSession.storePath, cronSession.store);
  }

  // Persist systemSent before the run, mirroring the inbound auto-reply behavior.
  if (isFirstTurnInSession) {
    cronSession.sessionEntry.systemSent = true;
    cronSession.store[params.sessionKey] = cronSession.sessionEntry;
    await saveSessionStore(cronSession.storePath, cronSession.store);
  } else {
    cronSession.store[params.sessionKey] = cronSession.sessionEntry;
    await saveSessionStore(cronSession.storePath, cronSession.store);
  }

  let runResult: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  let fallbackProvider = provider;
  let fallbackModel = model;
  try {
    const sessionFile = resolveSessionTranscriptPath(
      cronSession.sessionEntry.sessionId,
    );
    const resolvedVerboseLevel =
      (cronSession.sessionEntry.verboseLevel as "on" | "off" | undefined) ??
      (agentCfg?.verboseDefault as "on" | "off" | undefined);
    registerAgentRunContext(cronSession.sessionEntry.sessionId, {
      sessionKey: params.sessionKey,
      verboseLevel: resolvedVerboseLevel,
    });
    const messageProvider = resolvedDelivery.provider;
    const fallbackResult = await runWithModelFallback({
      cfg: params.cfg,
      provider,
      model,
      run: (providerOverride, modelOverride) => {
        if (isCliProvider(providerOverride, params.cfg)) {
          const cliSessionId = getCliSessionId(
            cronSession.sessionEntry,
            providerOverride,
          );
          return runCliAgent({
            sessionId: cronSession.sessionEntry.sessionId,
            sessionKey: params.sessionKey,
            sessionFile,
            workspaceDir,
            config: params.cfg,
            prompt: commandBody,
            provider: providerOverride,
            model: modelOverride,
            thinkLevel,
            timeoutMs,
            runId: cronSession.sessionEntry.sessionId,
            cliSessionId,
          });
        }
        return runEmbeddedPiAgent({
          sessionId: cronSession.sessionEntry.sessionId,
          sessionKey: params.sessionKey,
          messageProvider,
          sessionFile,
          workspaceDir,
          config: params.cfg,
          skillsSnapshot,
          prompt: commandBody,
          lane: params.lane ?? "cron",
          provider: providerOverride,
          model: modelOverride,
          thinkLevel,
          verboseLevel: resolvedVerboseLevel,
          timeoutMs,
          runId: cronSession.sessionEntry.sessionId,
        });
      },
    });
    runResult = fallbackResult.result;
    fallbackProvider = fallbackResult.provider;
    fallbackModel = fallbackResult.model;
  } catch (err) {
    return { status: "error", error: String(err) };
  }

  const payloads = runResult.payloads ?? [];

  // Update token+model fields in the session store.
  {
    const usage = runResult.meta.agentMeta?.usage;
    const modelUsed = runResult.meta.agentMeta?.model ?? fallbackModel ?? model;
    const providerUsed =
      runResult.meta.agentMeta?.provider ?? fallbackProvider ?? provider;
    const contextTokens =
      agentCfg?.contextTokens ??
      lookupContextTokens(modelUsed) ??
      DEFAULT_CONTEXT_TOKENS;

    cronSession.sessionEntry.modelProvider = providerUsed;
    cronSession.sessionEntry.model = modelUsed;
    cronSession.sessionEntry.contextTokens = contextTokens;
    if (isCliProvider(providerUsed, params.cfg)) {
      const cliSessionId = runResult.meta.agentMeta?.sessionId?.trim();
      if (cliSessionId) {
        setCliSessionId(cronSession.sessionEntry, providerUsed, cliSessionId);
      }
    }
    if (hasNonzeroUsage(usage)) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const promptTokens =
        input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      cronSession.sessionEntry.inputTokens = input;
      cronSession.sessionEntry.outputTokens = output;
      cronSession.sessionEntry.totalTokens =
        promptTokens > 0 ? promptTokens : (usage.total ?? input);
    }
    cronSession.store[params.sessionKey] = cronSession.sessionEntry;
    await saveSessionStore(cronSession.storePath, cronSession.store);
  }
  const firstText = payloads[0]?.text ?? "";
  const summary =
    pickSummaryFromPayloads(payloads) ?? pickSummaryFromOutput(firstText);

  // Skip delivery for heartbeat-only responses (HEARTBEAT_OK with no real content).
  // This allows cron jobs to silently ack when nothing to report but still deliver
  // actual content when there is something to say.
  const ackMaxChars =
    params.cfg.agents?.defaults?.heartbeat?.ackMaxChars ??
    DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  const skipHeartbeatDelivery =
    delivery && isHeartbeatOnlyResponse(payloads, Math.max(0, ackMaxChars));

  if (delivery && !skipHeartbeatDelivery) {
    if (!resolvedDelivery.to) {
      const reason =
        resolvedDelivery.error?.message ??
        "Cron delivery requires a recipient (--to).";
      if (!bestEffortDeliver) {
        return {
          status: "error",
          summary,
          error: reason,
        };
      }
      return {
        status: "skipped",
        summary: `Delivery skipped (${reason}).`,
      };
    }
    try {
      await deliverOutboundPayloads({
        cfg: params.cfg,
        provider: resolvedDelivery.provider as Exclude<OutboundProvider, "none">,
        to: resolvedDelivery.to,
        accountId: resolvedDelivery.accountId,
        payloads,
        bestEffort: bestEffortDeliver,
        deps: {
          sendWhatsApp: params.deps.sendMessageWhatsApp,
          sendTelegram: params.deps.sendMessageTelegram,
          sendDiscord: params.deps.sendMessageDiscord,
          sendSlack: params.deps.sendMessageSlack,
          sendSignal: params.deps.sendMessageSignal,
          sendIMessage: params.deps.sendMessageIMessage,
          sendMSTeams: params.deps.sendMessageMSTeams,
        },
      });
    } catch (err) {
      if (!bestEffortDeliver) {
        return { status: "error", summary, error: String(err) };
      }
      return { status: "ok", summary };
    }
  }

  return { status: "ok", summary };
}
