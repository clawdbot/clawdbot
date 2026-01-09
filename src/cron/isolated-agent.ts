import crypto from "node:crypto";
import { runClaudeCliAgent } from "../agents/claude-cli-runner.js";
import { lookupContextTokens } from "../agents/context.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runWithModelFallback } from "../agents/model-fallback.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
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
  chunkMarkdownText,
  chunkText,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
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
import { parseTelegramTarget } from "../telegram/targets.js";
import { resolveTelegramToken } from "../telegram/token.js";
import { normalizeE164, truncateUtf16Safe } from "../utils.js";
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

function getMediaList(payload: DeliveryPayload) {
  return payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
}

async function deliverPayloadsWithMedia(params: {
  payloads: DeliveryPayload[];
  sendText: (text: string) => Promise<unknown>;
  sendMedia: (caption: string, mediaUrl: string) => Promise<unknown>;
}) {
  for (const payload of params.payloads) {
    const mediaList = getMediaList(payload);
    if (mediaList.length === 0) {
      await params.sendText(payload.text ?? "");
      continue;
    }
    let first = true;
    for (const url of mediaList) {
      const caption = first ? (payload.text ?? "") : "";
      first = false;
      await params.sendMedia(caption, url);
    }
  }
}

async function deliverChunkedPayloads(params: {
  payloads: DeliveryPayload[];
  chunkText: (text: string) => string[];
  sendText: (text: string) => Promise<unknown>;
  sendMedia: (caption: string, mediaUrl: string) => Promise<unknown>;
}) {
  for (const payload of params.payloads) {
    const mediaList = getMediaList(payload);
    if (mediaList.length === 0) {
      for (const chunk of params.chunkText(payload.text ?? "")) {
        await params.sendText(chunk);
      }
      continue;
    }
    let first = true;
    for (const url of mediaList) {
      const caption = first ? (payload.text ?? "") : "";
      first = false;
      await params.sendMedia(caption, url);
    }
  }
}
function resolveDeliveryTarget(
  cfg: ClawdbotConfig,
  jobPayload: {
    provider?:
      | "last"
      | "whatsapp"
      | "telegram"
      | "discord"
      | "slack"
      | "signal"
      | "imessage"
      | "msteams";
    to?: string;
  },
) {
  const requestedProvider =
    typeof jobPayload.provider === "string" ? jobPayload.provider : "last";
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
      ? main.lastProvider
      : undefined;
  const lastTo = typeof main?.lastTo === "string" ? main.lastTo.trim() : "";

  const provider = (() => {
    if (
      requestedProvider === "whatsapp" ||
      requestedProvider === "telegram" ||
      requestedProvider === "discord" ||
      requestedProvider === "slack" ||
      requestedProvider === "signal" ||
      requestedProvider === "imessage"
    ) {
      return requestedProvider;
    }
    return lastProvider ?? "whatsapp";
  })();

  const rawTo = explicitTo ?? (lastTo || undefined);
  const telegramTarget =
    provider === "telegram" && rawTo ? parseTelegramTarget(rawTo) : undefined;

  const sanitizedWhatsappTo = (() => {
    if (provider !== "whatsapp") return rawTo;
    const rawAllow = cfg.whatsapp?.allowFrom ?? [];
    if (rawAllow.includes("*")) return rawTo;
    const allowFrom = rawAllow
      .map((val) => normalizeE164(val))
      .filter((val) => val.length > 1);
    if (allowFrom.length === 0) return rawTo;
    if (!rawTo) return allowFrom[0];
    const normalized = normalizeE164(rawTo);
    if (allowFrom.includes(normalized)) return normalized;
    return allowFrom[0];
  })();

  const to = (() => {
    if (provider === "telegram" && telegramTarget) return telegramTarget.chatId;
    if (provider === "whatsapp") return sanitizedWhatsappTo;
    return rawTo;
  })();

  return {
    provider,
    to,
    messageThreadId: telegramTarget?.messageThreadId,
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
  const modelOverrideRaw =
    params.job.payload.kind === "agentTurn"
      ? params.job.payload.model
      : undefined;
  if (modelOverrideRaw !== undefined) {
    if (typeof modelOverrideRaw !== "string") {
      return { status: "error", error: "invalid model: expected string" };
    }
    const trimmed = modelOverrideRaw.trim();
    if (!trimmed) {
      return { status: "error", error: "invalid model: empty" };
    }
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: resolvedDefault.provider,
    });
    const resolvedOverride = resolveModelRefFromString({
      raw: trimmed,
      defaultProvider: resolvedDefault.provider,
      aliasIndex,
    });
    if (!resolvedOverride) {
      return { status: "error", error: `invalid model: ${trimmed}` };
    }
    const allowed = buildAllowedModelSet({
      cfg: params.cfg,
      catalog: await loadCatalog(),
      defaultProvider: resolvedDefault.provider,
      defaultModel: resolvedDefault.model,
    });
    const key = modelKey(
      resolvedOverride.ref.provider,
      resolvedOverride.ref.model,
    );
    if (!allowed.allowAny && !allowed.allowedKeys.has(key)) {
      return { status: "error", error: `model not allowed: ${key}` };
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

  const thinkOverride = normalizeThinkLevel(agentCfg?.thinkingDefault);
  const jobThink = normalizeThinkLevel(
    (params.job.payload.kind === "agentTurn"
      ? params.job.payload.thinking
      : undefined) ?? undefined,
  );
  let thinkLevel = jobThink ?? thinkOverride;
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

  const resolvedDelivery = resolveDeliveryTarget(params.cfg, {
    provider:
      params.job.payload.kind === "agentTurn"
        ? params.job.payload.provider
        : "last",
    to:
      params.job.payload.kind === "agentTurn"
        ? params.job.payload.to
        : undefined,
  });
  const { token: telegramToken } = resolveTelegramToken(params.cfg);

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
    registerAgentRunContext(cronSession.sessionEntry.sessionId, {
      sessionKey: params.sessionKey,
    });
    const messageProvider = resolvedDelivery.provider;
    const claudeSessionId = cronSession.sessionEntry.claudeCliSessionId?.trim();
    const fallbackResult = await runWithModelFallback({
      cfg: params.cfg,
      provider,
      model,
      run: (providerOverride, modelOverride) => {
        if (providerOverride === "claude-cli") {
          return runClaudeCliAgent({
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
            claudeSessionId,
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
          verboseLevel:
            (cronSession.sessionEntry.verboseLevel as
              | "on"
              | "off"
              | undefined) ??
            (agentCfg?.verboseDefault as "on" | "off" | undefined),
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
    if (providerUsed === "claude-cli") {
      const cliSessionId = runResult.meta.agentMeta?.sessionId?.trim();
      if (cliSessionId) {
        cronSession.sessionEntry.claudeCliSessionId = cliSessionId;
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
    if (resolvedDelivery.provider === "whatsapp") {
      if (!resolvedDelivery.to) {
        if (!bestEffortDeliver)
          return {
            status: "error",
            summary,
            error: "Cron delivery to WhatsApp requires a recipient.",
          };
        return {
          status: "skipped",
          summary: "Delivery skipped (no WhatsApp recipient).",
        };
      }
      const to = normalizeE164(resolvedDelivery.to);
      try {
        await deliverPayloadsWithMedia({
          payloads,
          sendText: (text) =>
            params.deps.sendMessageWhatsApp(to, text, { verbose: false }),
          sendMedia: (caption, mediaUrl) =>
            params.deps.sendMessageWhatsApp(to, caption, {
              verbose: false,
              mediaUrl,
            }),
        });
      } catch (err) {
        if (!bestEffortDeliver)
          return { status: "error", summary, error: String(err) };
        return { status: "ok", summary };
      }
    } else if (resolvedDelivery.provider === "telegram") {
      if (!resolvedDelivery.to) {
        if (!bestEffortDeliver)
          return {
            status: "error",
            summary,
            error: "Cron delivery to Telegram requires a chatId.",
          };
        return {
          status: "skipped",
          summary: "Delivery skipped (no Telegram chatId).",
        };
      }
      const chatId = resolvedDelivery.to;
      const messageThreadId = resolvedDelivery.messageThreadId;
      const textLimit = resolveTextChunkLimit(params.cfg, "telegram");
      try {
        await deliverChunkedPayloads({
          payloads,
          chunkText: (text) => chunkMarkdownText(text, textLimit),
          sendText: (text) =>
            params.deps.sendMessageTelegram(chatId, text, {
              verbose: false,
              token: telegramToken || undefined,
              messageThreadId,
            }),
          sendMedia: (caption, mediaUrl) =>
            params.deps.sendMessageTelegram(chatId, caption, {
              verbose: false,
              mediaUrl,
              token: telegramToken || undefined,
              messageThreadId,
            }),
        });
      } catch (err) {
        if (!bestEffortDeliver)
          return { status: "error", summary, error: String(err) };
        return { status: "ok", summary };
      }
    } else if (resolvedDelivery.provider === "discord") {
      if (!resolvedDelivery.to) {
        if (!bestEffortDeliver)
          return {
            status: "error",
            summary,
            error:
              "Cron delivery to Discord requires --provider discord and --to <channelId|user:ID>",
          };
        return {
          status: "skipped",
          summary: "Delivery skipped (no Discord destination).",
        };
      }
      const discordTarget = resolvedDelivery.to;
      try {
        await deliverPayloadsWithMedia({
          payloads,
          sendText: (text) =>
            params.deps.sendMessageDiscord(discordTarget, text, {
              token: process.env.DISCORD_BOT_TOKEN,
            }),
          sendMedia: (caption, mediaUrl) =>
            params.deps.sendMessageDiscord(discordTarget, caption, {
              token: process.env.DISCORD_BOT_TOKEN,
              mediaUrl,
            }),
        });
      } catch (err) {
        if (!bestEffortDeliver)
          return { status: "error", summary, error: String(err) };
        return { status: "ok", summary };
      }
    } else if (resolvedDelivery.provider === "slack") {
      if (!resolvedDelivery.to) {
        if (!bestEffortDeliver)
          return {
            status: "error",
            summary,
            error:
              "Cron delivery to Slack requires --provider slack and --to <channelId|user:ID>",
          };
        return {
          status: "skipped",
          summary: "Delivery skipped (no Slack destination).",
        };
      }
      const slackTarget = resolvedDelivery.to;
      const textLimit = resolveTextChunkLimit(params.cfg, "slack");
      try {
        await deliverChunkedPayloads({
          payloads,
          chunkText: (text) => chunkMarkdownText(text, textLimit),
          sendText: (text) => params.deps.sendMessageSlack(slackTarget, text),
          sendMedia: (caption, mediaUrl) =>
            params.deps.sendMessageSlack(slackTarget, caption, { mediaUrl }),
        });
      } catch (err) {
        if (!bestEffortDeliver)
          return { status: "error", summary, error: String(err) };
        return { status: "ok", summary };
      }
    } else if (resolvedDelivery.provider === "signal") {
      if (!resolvedDelivery.to) {
        if (!bestEffortDeliver)
          return {
            status: "error",
            summary,
            error: "Cron delivery to Signal requires a recipient.",
          };
        return {
          status: "skipped",
          summary: "Delivery skipped (no Signal recipient).",
        };
      }
      const to = resolvedDelivery.to;
      const textLimit = resolveTextChunkLimit(params.cfg, "signal");
      try {
        await deliverChunkedPayloads({
          payloads,
          chunkText: (text) => chunkText(text, textLimit),
          sendText: (text) => params.deps.sendMessageSignal(to, text),
          sendMedia: (caption, mediaUrl) =>
            params.deps.sendMessageSignal(to, caption, { mediaUrl }),
        });
      } catch (err) {
        if (!bestEffortDeliver)
          return { status: "error", summary, error: String(err) };
        return { status: "ok", summary };
      }
    } else if (resolvedDelivery.provider === "imessage") {
      if (!resolvedDelivery.to) {
        if (!bestEffortDeliver)
          return {
            status: "error",
            summary,
            error: "Cron delivery to iMessage requires a recipient.",
          };
        return {
          status: "skipped",
          summary: "Delivery skipped (no iMessage recipient).",
        };
      }
      const to = resolvedDelivery.to;
      const textLimit = resolveTextChunkLimit(params.cfg, "imessage");
      try {
        await deliverChunkedPayloads({
          payloads,
          chunkText: (text) => chunkText(text, textLimit),
          sendText: (text) => params.deps.sendMessageIMessage(to, text),
          sendMedia: (caption, mediaUrl) =>
            params.deps.sendMessageIMessage(to, caption, { mediaUrl }),
        });
      } catch (err) {
        if (!bestEffortDeliver)
          return { status: "error", summary, error: String(err) };
        return { status: "ok", summary };
      }
    }
  }

  return { status: "ok", summary };
}
