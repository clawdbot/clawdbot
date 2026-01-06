import crypto from "node:crypto";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
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
  modelKey,
  resolveConfiguredModelRef,
  resolveThinkingDefault,
} from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { buildWorkspaceSkillSnapshot } from "../agents/skills.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import {
  DEFAULT_AGENT_WORKSPACE_DIR,
  ensureAgentWorkspace,
} from "../agents/workspace.js";
import { chunkText, resolveTextChunkLimit } from "../auto-reply/chunk.js";
import type { MsgContext } from "../auto-reply/templating.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import { type CliDeps, createDefaultDeps } from "../cli/deps.js";
import { type ClawdbotConfig, loadConfig } from "../config/config.js";
import {
  DEFAULT_IDLE_MINUTES,
  loadSessionStore,
  resolveSessionKey,
  resolveSessionTranscriptPath,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import {
  emitAgentEvent,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { resolveTelegramToken } from "../telegram/token.js";
import { normalizeE164 } from "../utils.js";

type AgentCommandOpts = {
  message: string;
  to?: string;
  sessionId?: string;
  thinking?: string;
  thinkingOnce?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  surface?: string;
  provider?: string; // delivery provider (whatsapp|telegram|...)
  bestEffortDeliver?: boolean;
  abortSignal?: AbortSignal;
  lane?: string;
  runId?: string;
  extraSystemPrompt?: string;
};

type SessionResolution = {
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  storePath: string;
  isNewSession: boolean;
  persistedThinking?: ThinkLevel;
  persistedVerbose?: VerboseLevel;
};

function resolveSession(opts: {
  cfg: ClawdbotConfig;
  to?: string;
  sessionId?: string;
}): SessionResolution {
  const sessionCfg = opts.cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const mainKey = sessionCfg?.mainKey ?? "main";
  const idleMinutes = Math.max(
    sessionCfg?.idleMinutes ?? DEFAULT_IDLE_MINUTES,
    1,
  );
  const idleMs = idleMinutes * 60_000;
  const storePath = resolveStorePath(sessionCfg?.store);
  const sessionStore = loadSessionStore(storePath);
  const now = Date.now();

  const ctx: MsgContext | undefined = opts.to?.trim()
    ? { From: opts.to }
    : undefined;
  let sessionKey: string | undefined = ctx
    ? resolveSessionKey(scope, ctx, mainKey)
    : undefined;
  let sessionEntry = sessionKey ? sessionStore[sessionKey] : undefined;

  // If a session id was provided, prefer to re-use its entry (by id) even when no key was derived.
  if (
    opts.sessionId &&
    (!sessionEntry || sessionEntry.sessionId !== opts.sessionId)
  ) {
    const foundKey = Object.keys(sessionStore).find(
      (key) => sessionStore[key]?.sessionId === opts.sessionId,
    );
    if (foundKey) {
      sessionKey = sessionKey ?? foundKey;
      sessionEntry = sessionStore[foundKey];
    }
  }

  const fresh = sessionEntry && sessionEntry.updatedAt >= now - idleMs;
  const sessionId =
    opts.sessionId?.trim() ||
    (fresh ? sessionEntry?.sessionId : undefined) ||
    crypto.randomUUID();
  const isNewSession = !fresh && !opts.sessionId;

  const persistedThinking =
    fresh && sessionEntry?.thinkingLevel
      ? normalizeThinkLevel(sessionEntry.thinkingLevel)
      : undefined;
  const persistedVerbose =
    fresh && sessionEntry?.verboseLevel
      ? normalizeVerboseLevel(sessionEntry.verboseLevel)
      : undefined;

  return {
    sessionId,
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
  };
}

export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  const body = (opts.message ?? "").trim();
  if (!body) throw new Error("Message (--message) is required");
  if (!opts.to && !opts.sessionId) {
    throw new Error("Pass --to <E.164> or --session-id to choose a session");
  }

  const cfg = loadConfig();
  const agentCfg = cfg.agent;
  const workspaceDirRaw = cfg.agent?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: true,
  });
  const workspaceDir = workspace.dir;

  const allowFrom = (cfg.whatsapp?.allowFrom ?? [])
    .map((val) => normalizeE164(val))
    .filter((val) => val.length > 1);

  const thinkOverride = normalizeThinkLevel(opts.thinking);
  const thinkOnce = normalizeThinkLevel(opts.thinkingOnce);
  if (opts.thinking && !thinkOverride) {
    throw new Error(
      "Invalid thinking level. Use one of: off, minimal, low, medium, high.",
    );
  }
  if (opts.thinkingOnce && !thinkOnce) {
    throw new Error(
      "Invalid one-shot thinking level. Use one of: off, minimal, low, medium, high.",
    );
  }

  const verboseOverride = normalizeVerboseLevel(opts.verbose);
  if (opts.verbose && !verboseOverride) {
    throw new Error('Invalid verbose level. Use "on" or "off".');
  }

  const timeoutSecondsRaw =
    opts.timeout !== undefined
      ? Number.parseInt(String(opts.timeout), 10)
      : undefined;
  if (
    timeoutSecondsRaw !== undefined &&
    (Number.isNaN(timeoutSecondsRaw) || timeoutSecondsRaw <= 0)
  ) {
    throw new Error("--timeout must be a positive integer (seconds)");
  }
  const timeoutMs = resolveAgentTimeoutMs({
    cfg,
    overrideSeconds: timeoutSecondsRaw,
  });

  const sessionResolution = resolveSession({
    cfg,
    to: opts.to,
    sessionId: opts.sessionId,
  });

  const {
    sessionId,
    sessionKey,
    sessionEntry: resolvedSessionEntry,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
  } = sessionResolution;
  let sessionEntry = resolvedSessionEntry;
  const runId = opts.runId?.trim() || sessionId;

  if (sessionKey) {
    registerAgentRunContext(runId, { sessionKey });
  }

  if (opts.deliver === true) {
    const sendPolicy = resolveSendPolicy({
      cfg,
      entry: sessionEntry,
      sessionKey,
      surface: sessionEntry?.surface,
      chatType: sessionEntry?.chatType,
    });
    if (sendPolicy === "deny") {
      throw new Error("send blocked by session policy");
    }
  }

  let resolvedThinkLevel =
    thinkOnce ??
    thinkOverride ??
    persistedThinking ??
    (agentCfg?.thinkingDefault as ThinkLevel | undefined);
  const resolvedVerboseLevel =
    verboseOverride ??
    persistedVerbose ??
    (agentCfg?.verboseDefault as VerboseLevel | undefined);

  const needsSkillsSnapshot = isNewSession || !sessionEntry?.skillsSnapshot;
  const skillsSnapshot = needsSkillsSnapshot
    ? buildWorkspaceSkillSnapshot(workspaceDir, { config: cfg })
    : sessionEntry?.skillsSnapshot;

  const { token: telegramToken } = resolveTelegramToken(cfg);

  if (skillsSnapshot && sessionStore && sessionKey && needsSkillsSnapshot) {
    const current = sessionEntry ?? {
      sessionId,
      updatedAt: Date.now(),
    };
    const next: SessionEntry = {
      ...current,
      sessionId,
      updatedAt: Date.now(),
      skillsSnapshot,
    };
    sessionStore[sessionKey] = next;
    await saveSessionStore(storePath, sessionStore);
    sessionEntry = next;
  }

  // Persist explicit /command overrides to the session store when we have a key.
  if (sessionStore && sessionKey) {
    const entry = sessionStore[sessionKey] ??
      sessionEntry ?? { sessionId, updatedAt: Date.now() };
    const next: SessionEntry = { ...entry, sessionId, updatedAt: Date.now() };
    if (thinkOverride) {
      if (thinkOverride === "off") delete next.thinkingLevel;
      else next.thinkingLevel = thinkOverride;
    }
    if (verboseOverride) {
      if (verboseOverride === "off") delete next.verboseLevel;
      else next.verboseLevel = verboseOverride;
    }
    sessionStore[sessionKey] = next;
    await saveSessionStore(storePath, sessionStore);
  }

  const { provider: defaultProvider, model: defaultModel } =
    resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
  let provider = defaultProvider;
  let model = defaultModel;
  const hasAllowlist =
    agentCfg?.models && Object.keys(agentCfg.models).length > 0;
  const hasStoredOverride = Boolean(
    sessionEntry?.modelOverride || sessionEntry?.providerOverride,
  );
  const needsModelCatalog = hasAllowlist || hasStoredOverride;
  let allowedModelKeys = new Set<string>();
  let allowedModelCatalog: Awaited<ReturnType<typeof loadModelCatalog>> = [];
  let modelCatalog: Awaited<ReturnType<typeof loadModelCatalog>> | null = null;

  if (needsModelCatalog) {
    modelCatalog = await loadModelCatalog({ config: cfg });
    const allowed = buildAllowedModelSet({
      cfg,
      catalog: modelCatalog,
      defaultProvider,
    });
    allowedModelKeys = allowed.allowedKeys;
    allowedModelCatalog = allowed.allowedCatalog;
  }

  if (sessionEntry && sessionStore && sessionKey && hasStoredOverride) {
    const overrideProvider =
      sessionEntry.providerOverride?.trim() || defaultProvider;
    const overrideModel = sessionEntry.modelOverride?.trim();
    if (overrideModel) {
      const key = modelKey(overrideProvider, overrideModel);
      if (allowedModelKeys.size > 0 && !allowedModelKeys.has(key)) {
        delete sessionEntry.providerOverride;
        delete sessionEntry.modelOverride;
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        await saveSessionStore(storePath, sessionStore);
      }
    }
  }

  const storedProviderOverride = sessionEntry?.providerOverride?.trim();
  const storedModelOverride = sessionEntry?.modelOverride?.trim();
  if (storedModelOverride) {
    const candidateProvider = storedProviderOverride || defaultProvider;
    const key = modelKey(candidateProvider, storedModelOverride);
    if (allowedModelKeys.size === 0 || allowedModelKeys.has(key)) {
      provider = candidateProvider;
      model = storedModelOverride;
    }
  }
  if (sessionEntry?.authProfileOverride) {
    const store = ensureAuthProfileStore();
    const profile = store.profiles[sessionEntry.authProfileOverride];
    if (!profile || profile.provider !== provider) {
      delete sessionEntry.authProfileOverride;
      sessionEntry.updatedAt = Date.now();
      if (sessionStore && sessionKey) {
        sessionStore[sessionKey] = sessionEntry;
        await saveSessionStore(storePath, sessionStore);
      }
    }
  }

  if (!resolvedThinkLevel) {
    let catalogForThinking = modelCatalog ?? allowedModelCatalog;
    if (!catalogForThinking || catalogForThinking.length === 0) {
      modelCatalog = await loadModelCatalog({ config: cfg });
      catalogForThinking = modelCatalog;
    }
    resolvedThinkLevel = resolveThinkingDefault({
      cfg,
      provider,
      model,
      catalog: catalogForThinking,
    });
  }
  const sessionFile = resolveSessionTranscriptPath(sessionId);

  const startedAt = Date.now();
  let lifecycleEnded = false;

  let result: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
  let fallbackProvider = provider;
  let fallbackModel = model;
  try {
    const surface =
      opts.surface?.trim().toLowerCase() ||
      (() => {
        const raw = opts.provider?.trim().toLowerCase();
        if (!raw) return undefined;
        return raw === "imsg" ? "imessage" : raw;
      })();
    const fallbackResult = await runWithModelFallback({
      cfg,
      provider,
      model,
      run: (providerOverride, modelOverride) =>
        runEmbeddedPiAgent({
          sessionId,
          sessionKey,
          surface,
          sessionFile,
          workspaceDir,
          config: cfg,
          skillsSnapshot,
          prompt: body,
          provider: providerOverride,
          model: modelOverride,
          authProfileId: sessionEntry?.authProfileOverride,
          thinkLevel: resolvedThinkLevel,
          verboseLevel: resolvedVerboseLevel,
          timeoutMs,
          runId,
          lane: opts.lane,
          abortSignal: opts.abortSignal,
          extraSystemPrompt: opts.extraSystemPrompt,
          onAgentEvent: (evt) => {
            if (
              evt.stream === "lifecycle" &&
              typeof evt.data?.phase === "string" &&
              (evt.data.phase === "end" || evt.data.phase === "error")
            ) {
              lifecycleEnded = true;
            }
            emitAgentEvent({
              runId,
              stream: evt.stream,
              data: evt.data,
            });
          },
        }),
    });
    result = fallbackResult.result;
    fallbackProvider = fallbackResult.provider;
    fallbackModel = fallbackResult.model;
    if (!lifecycleEnded) {
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt,
          endedAt: Date.now(),
          aborted: result.meta.aborted ?? false,
        },
      });
    }
  } catch (err) {
    if (!lifecycleEnded) {
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "error",
          startedAt,
          endedAt: Date.now(),
          error: String(err),
        },
      });
    }
    throw err;
  }

  // Update token+model fields in the session store.
  if (sessionStore && sessionKey) {
    const usage = result.meta.agentMeta?.usage;
    const modelUsed = result.meta.agentMeta?.model ?? fallbackModel ?? model;
    const providerUsed =
      result.meta.agentMeta?.provider ?? fallbackProvider ?? provider;
    const contextTokens =
      agentCfg?.contextTokens ??
      lookupContextTokens(modelUsed) ??
      DEFAULT_CONTEXT_TOKENS;

    const entry = sessionStore[sessionKey] ?? {
      sessionId,
      updatedAt: Date.now(),
    };
    const next: SessionEntry = {
      ...entry,
      sessionId,
      updatedAt: Date.now(),
      modelProvider: providerUsed,
      model: modelUsed,
      contextTokens,
    };
    next.abortedLastRun = result.meta.aborted ?? false;
    if (usage) {
      const input = usage.input ?? 0;
      const output = usage.output ?? 0;
      const promptTokens =
        input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      next.inputTokens = input;
      next.outputTokens = output;
      next.totalTokens =
        promptTokens > 0 ? promptTokens : (usage.total ?? input);
    }
    sessionStore[sessionKey] = next;
    await saveSessionStore(storePath, sessionStore);
  }

  const payloads = result.payloads ?? [];
  const deliver = opts.deliver === true;
  const bestEffortDeliver = opts.bestEffortDeliver === true;
  const deliveryProviderRaw = (opts.provider ?? "whatsapp").toLowerCase();
  const deliveryProvider =
    deliveryProviderRaw === "imsg" ? "imessage" : deliveryProviderRaw;

  const whatsappTarget = opts.to ? normalizeE164(opts.to) : allowFrom[0];
  const telegramTarget = opts.to?.trim() || undefined;
  const discordTarget = opts.to?.trim() || undefined;
  const slackTarget = opts.to?.trim() || undefined;
  const signalTarget = opts.to?.trim() || undefined;
  const imessageTarget = opts.to?.trim() || undefined;

  const logDeliveryError = (err: unknown) => {
    const deliveryTarget =
      deliveryProvider === "telegram"
        ? telegramTarget
        : deliveryProvider === "whatsapp"
          ? whatsappTarget
          : deliveryProvider === "discord"
            ? discordTarget
            : deliveryProvider === "slack"
              ? slackTarget
              : deliveryProvider === "signal"
                ? signalTarget
                : deliveryProvider === "imessage"
                  ? imessageTarget
                  : undefined;
    const message = `Delivery failed (${deliveryProvider}${deliveryTarget ? ` to ${deliveryTarget}` : ""}): ${String(err)}`;
    runtime.error?.(message);
    if (!runtime.error) runtime.log(message);
  };

  if (deliver) {
    if (deliveryProvider === "whatsapp" && !whatsappTarget) {
      const err = new Error(
        "Delivering to WhatsApp requires --to <E.164> or whatsapp.allowFrom[0]",
      );
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    }
    if (deliveryProvider === "telegram" && !telegramTarget) {
      const err = new Error("Delivering to Telegram requires --to <chatId>");
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    }
    if (deliveryProvider === "discord" && !discordTarget) {
      const err = new Error(
        "Delivering to Discord requires --to <channelId|user:ID|channel:ID>",
      );
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    }
    if (deliveryProvider === "slack" && !slackTarget) {
      const err = new Error(
        "Delivering to Slack requires --to <channelId|user:ID|channel:ID>",
      );
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    }
    if (deliveryProvider === "signal" && !signalTarget) {
      const err = new Error(
        "Delivering to Signal requires --to <E.164|group:ID|signal:group:ID|signal:+E.164>",
      );
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    }
    if (deliveryProvider === "imessage" && !imessageTarget) {
      const err = new Error(
        "Delivering to iMessage requires --to <handle|chat_id:ID>",
      );
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    }
    if (deliveryProvider === "webchat") {
      const err = new Error(
        "Delivering to WebChat is not supported via `clawdbot agent`; use WhatsApp/Telegram or run with --deliver=false.",
      );
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    }
    if (
      deliveryProvider !== "whatsapp" &&
      deliveryProvider !== "telegram" &&
      deliveryProvider !== "discord" &&
      deliveryProvider !== "slack" &&
      deliveryProvider !== "signal" &&
      deliveryProvider !== "imessage" &&
      deliveryProvider !== "webchat"
    ) {
      const err = new Error(`Unknown provider: ${deliveryProvider}`);
      if (!bestEffortDeliver) throw err;
      logDeliveryError(err);
    }
  }

  if (opts.json) {
    const normalizedPayloads = payloads.map((p) => ({
      text: p.text ?? "",
      mediaUrl: p.mediaUrl ?? null,
      mediaUrls: p.mediaUrls ?? (p.mediaUrl ? [p.mediaUrl] : undefined),
    }));
    runtime.log(
      JSON.stringify(
        { payloads: normalizedPayloads, meta: result.meta },
        null,
        2,
      ),
    );
    if (!deliver) {
      return { payloads: normalizedPayloads, meta: result.meta };
    }
  }

  if (payloads.length === 0) {
    runtime.log("No reply from agent.");
    return { payloads: [], meta: result.meta };
  }

  const deliveryTextLimit =
    deliveryProvider === "whatsapp" ||
    deliveryProvider === "telegram" ||
    deliveryProvider === "discord" ||
    deliveryProvider === "slack" ||
    deliveryProvider === "signal" ||
    deliveryProvider === "imessage"
      ? resolveTextChunkLimit(cfg, deliveryProvider)
      : resolveTextChunkLimit(cfg, "whatsapp");

  for (const payload of payloads) {
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);

    if (!opts.json) {
      const lines: string[] = [];
      if (payload.text) lines.push(payload.text.trimEnd());
      for (const url of mediaList) lines.push(`MEDIA:${url}`);
      runtime.log(lines.join("\n"));
    }

    if (!deliver) continue;

    const text = payload.text ?? "";
    const media = mediaList;
    if (!text && media.length === 0) continue;

    if (deliveryProvider === "whatsapp" && whatsappTarget) {
      try {
        const primaryMedia = media[0];
        await deps.sendMessageWhatsApp(whatsappTarget, text, {
          verbose: false,
          mediaUrl: primaryMedia,
        });
        for (const extra of media.slice(1)) {
          await deps.sendMessageWhatsApp(whatsappTarget, "", {
            verbose: false,
            mediaUrl: extra,
          });
        }
      } catch (err) {
        if (!bestEffortDeliver) throw err;
        logDeliveryError(err);
      }
      continue;
    }

    if (deliveryProvider === "telegram" && telegramTarget) {
      try {
        if (media.length === 0) {
          for (const chunk of chunkText(text, deliveryTextLimit)) {
            await deps.sendMessageTelegram(telegramTarget, chunk, {
              verbose: false,
              token: telegramToken || undefined,
            });
          }
        } else {
          let first = true;
          for (const url of media) {
            const caption = first ? text : "";
            first = false;
            await deps.sendMessageTelegram(telegramTarget, caption, {
              verbose: false,
              mediaUrl: url,
              token: telegramToken || undefined,
            });
          }
        }
      } catch (err) {
        if (!bestEffortDeliver) throw err;
        logDeliveryError(err);
      }
    }

    if (deliveryProvider === "discord" && discordTarget) {
      try {
        if (media.length === 0) {
          await deps.sendMessageDiscord(discordTarget, text, {
            token: process.env.DISCORD_BOT_TOKEN,
          });
        } else {
          let first = true;
          for (const url of media) {
            const caption = first ? text : "";
            first = false;
            await deps.sendMessageDiscord(discordTarget, caption, {
              token: process.env.DISCORD_BOT_TOKEN,
              mediaUrl: url,
            });
          }
        }
      } catch (err) {
        if (!bestEffortDeliver) throw err;
        logDeliveryError(err);
      }
    }

    if (deliveryProvider === "slack" && slackTarget) {
      try {
        if (media.length === 0) {
          await deps.sendMessageSlack(slackTarget, text);
        } else {
          let first = true;
          for (const url of media) {
            const caption = first ? text : "";
            first = false;
            await deps.sendMessageSlack(slackTarget, caption, {
              mediaUrl: url,
            });
          }
        }
      } catch (err) {
        if (!bestEffortDeliver) throw err;
        logDeliveryError(err);
      }
    }

    if (deliveryProvider === "signal" && signalTarget) {
      try {
        if (media.length === 0) {
          await deps.sendMessageSignal(signalTarget, text, {
            maxBytes: cfg.signal?.mediaMaxMb
              ? cfg.signal.mediaMaxMb * 1024 * 1024
              : cfg.agent?.mediaMaxMb
                ? cfg.agent.mediaMaxMb * 1024 * 1024
                : undefined,
          });
        } else {
          let first = true;
          for (const url of media) {
            const caption = first ? text : "";
            first = false;
            await deps.sendMessageSignal(signalTarget, caption, {
              mediaUrl: url,
              maxBytes: cfg.signal?.mediaMaxMb
                ? cfg.signal.mediaMaxMb * 1024 * 1024
                : cfg.agent?.mediaMaxMb
                  ? cfg.agent.mediaMaxMb * 1024 * 1024
                  : undefined,
            });
          }
        }
      } catch (err) {
        if (!bestEffortDeliver) throw err;
        logDeliveryError(err);
      }
    }

    if (deliveryProvider === "imessage" && imessageTarget) {
      try {
        if (media.length === 0) {
          for (const chunk of chunkText(text, deliveryTextLimit)) {
            await deps.sendMessageIMessage(imessageTarget, chunk, {
              maxBytes: cfg.imessage?.mediaMaxMb
                ? cfg.imessage.mediaMaxMb * 1024 * 1024
                : cfg.agent?.mediaMaxMb
                  ? cfg.agent.mediaMaxMb * 1024 * 1024
                  : undefined,
            });
          }
        } else {
          let first = true;
          for (const url of media) {
            const caption = first ? text : "";
            first = false;
            await deps.sendMessageIMessage(imessageTarget, caption, {
              mediaUrl: url,
              maxBytes: cfg.imessage?.mediaMaxMb
                ? cfg.imessage.mediaMaxMb * 1024 * 1024
                : cfg.agent?.mediaMaxMb
                  ? cfg.agent.mediaMaxMb * 1024 * 1024
                  : undefined,
            });
          }
        }
      } catch (err) {
        if (!bestEffortDeliver) throw err;
        logDeliveryError(err);
      }
    }
  }

  const normalizedPayloads = payloads.map((p) => ({
    text: p.text ?? "",
    mediaUrl: p.mediaUrl ?? null,
    mediaUrls: p.mediaUrls ?? (p.mediaUrl ? [p.mediaUrl] : undefined),
  }));
  return { payloads: normalizedPayloads, meta: result.meta };
}
