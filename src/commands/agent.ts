import {
  resolveAgentDir,
  resolveAgentModelFallbacksOverride,
  resolveAgentModelPrimary,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { runCliAgent } from "../agents/cli-runner.js";
import { getCliSessionId } from "../agents/cli-session.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runWithModelFallback } from "../agents/model-fallback.js";
import {
  buildAllowedModelSet,
  isCliProvider,
  modelKey,
  resolveConfiguredModelRef,
  resolveThinkingDefault,
} from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { buildWorkspaceSkillSnapshot } from "../agents/skills.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import {
  formatThinkingLevels,
  formatXHighModelHint,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  supportsXHighThinking,
  type ThinkLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import { type CliDeps, createDefaultDeps } from "../cli/deps.js";
import { loadConfig } from "../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import {
  clearAgentRunContext,
  emitAgentEvent,
  registerAgentRunContext,
} from "../infra/agent-events.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { applyVerboseOverride } from "../sessions/level-overrides.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { resolveMessageChannel } from "../utils/message-channel.js";
import { deliverAgentCommandResult } from "./agent/delivery.js";
import { resolveSession } from "./agent/session.js";
import { updateSessionStoreAfterAgentRun } from "./agent/session-store.js";
import type { AgentCommandOpts } from "./agent/types.js";

export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps: CliDeps = createDefaultDeps(),
) {
  const body = (opts.message ?? "").trim();
  if (!body) throw new Error("Message (--message) is required");
  if (!opts.to && !opts.sessionId && !opts.sessionKey) {
    throw new Error("Pass --to <E.164> or --session-id to choose a session");
  }

  const cfg = loadConfig();
  const agentCfg = cfg.agents?.defaults;
  const sessionAgentId = resolveAgentIdFromSessionKey(opts.sessionKey?.trim());
  const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, sessionAgentId);
  const agentDir = resolveAgentDir(cfg, sessionAgentId);
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap,
  });
  const workspaceDir = workspace.dir;
  const configuredModel = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const thinkingLevelsHint = formatThinkingLevels(configuredModel.provider, configuredModel.model);

  const thinkOverride = normalizeThinkLevel(opts.thinking);
  const thinkOnce = normalizeThinkLevel(opts.thinkingOnce);
  if (opts.thinking && !thinkOverride) {
    throw new Error(`Invalid thinking level. Use one of: ${thinkingLevelsHint}.`);
  }
  if (opts.thinkingOnce && !thinkOnce) {
    throw new Error(`Invalid one-shot thinking level. Use one of: ${thinkingLevelsHint}.`);
  }

  const verboseOverride = normalizeVerboseLevel(opts.verbose);
  if (opts.verbose && !verboseOverride) {
    throw new Error('Invalid verbose level. Use "on" or "off".');
  }

  const timeoutSecondsRaw =
    opts.timeout !== undefined ? Number.parseInt(String(opts.timeout), 10) : undefined;
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
    sessionKey: opts.sessionKey,
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

  try {
    if (opts.deliver === true) {
      const sendPolicy = resolveSendPolicy({
        cfg,
        entry: sessionEntry,
        sessionKey,
        channel: sessionEntry?.channel,
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
      verboseOverride ?? persistedVerbose ?? (agentCfg?.verboseDefault as VerboseLevel | undefined);

    if (sessionKey) {
      registerAgentRunContext(runId, {
        sessionKey,
        verboseLevel: resolvedVerboseLevel,
      });
    }

    const needsSkillsSnapshot = isNewSession || !sessionEntry?.skillsSnapshot;
    const skillsSnapshot = needsSkillsSnapshot
      ? buildWorkspaceSkillSnapshot(workspaceDir, { config: cfg })
      : sessionEntry?.skillsSnapshot;

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
      applyVerboseOverride(next, verboseOverride);
      sessionStore[sessionKey] = next;
      await saveSessionStore(storePath, sessionStore);
    }

    const agentModelPrimary = resolveAgentModelPrimary(cfg, sessionAgentId);
    const cfgForModelSelection = agentModelPrimary
      ? {
          ...cfg,
          agents: {
            ...cfg.agents,
            defaults: {
              ...cfg.agents?.defaults,
              model: {
                ...(typeof cfg.agents?.defaults?.model === "object"
                  ? cfg.agents.defaults.model
                  : undefined),
                primary: agentModelPrimary,
              },
            },
          },
        }
      : cfg;

    const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
      cfg: cfgForModelSelection,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    let provider = defaultProvider;
    let model = defaultModel;
    const hasAllowlist = agentCfg?.models && Object.keys(agentCfg.models).length > 0;
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
        defaultModel,
      });
      allowedModelKeys = allowed.allowedKeys;
      allowedModelCatalog = allowed.allowedCatalog;
    }

    if (sessionEntry && sessionStore && sessionKey && hasStoredOverride) {
      const overrideProvider = sessionEntry.providerOverride?.trim() || defaultProvider;
      const overrideModel = sessionEntry.modelOverride?.trim();
      if (overrideModel) {
        const key = modelKey(overrideProvider, overrideModel);
        if (
          !isCliProvider(overrideProvider, cfg) &&
          allowedModelKeys.size > 0 &&
          !allowedModelKeys.has(key)
        ) {
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
      if (
        isCliProvider(candidateProvider, cfg) ||
        allowedModelKeys.size === 0 ||
        allowedModelKeys.has(key)
      ) {
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
    if (resolvedThinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
      const explicitThink = Boolean(thinkOnce || thinkOverride);
      if (explicitThink) {
        throw new Error(`Thinking level "xhigh" is only supported for ${formatXHighModelHint()}.`);
      }
      resolvedThinkLevel = "high";
      if (sessionEntry && sessionStore && sessionKey && sessionEntry.thinkingLevel === "xhigh") {
        sessionEntry.thinkingLevel = "high";
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        await saveSessionStore(storePath, sessionStore);
      }
    }
    const sessionFile = resolveSessionFilePath(sessionId, sessionEntry, {
      agentId: sessionAgentId,
    });

    const startedAt = Date.now();
    let lifecycleEnded = false;

    let result: Awaited<ReturnType<typeof runEmbeddedPiAgent>>;
    let fallbackProvider = provider;
    let fallbackModel = model;
    try {
      const messageChannel = resolveMessageChannel(opts.messageChannel, opts.channel);
      const fallbackResult = await runWithModelFallback({
        cfg,
        provider,
        model,
        fallbacksOverride: resolveAgentModelFallbacksOverride(cfg, sessionAgentId),
        run: (providerOverride, modelOverride) => {
          if (isCliProvider(providerOverride, cfg)) {
            const cliSessionId = getCliSessionId(sessionEntry, providerOverride);
            return runCliAgent({
              sessionId,
              sessionKey,
              sessionFile,
              workspaceDir,
              config: cfg,
              prompt: body,
              provider: providerOverride,
              model: modelOverride,
              thinkLevel: resolvedThinkLevel,
              timeoutMs,
              runId,
              extraSystemPrompt: opts.extraSystemPrompt,
              cliSessionId,
              images: opts.images,
            });
          }
          return runEmbeddedPiAgent({
            sessionId,
            sessionKey,
            messageChannel,
            sessionFile,
            workspaceDir,
            config: cfg,
            skillsSnapshot,
            prompt: body,
            images: opts.images,
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
            agentDir,
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
          });
        },
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
      await updateSessionStoreAfterAgentRun({
        cfg,
        contextTokensOverride: agentCfg?.contextTokens,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: provider,
        defaultModel: model,
        fallbackProvider,
        fallbackModel,
        result,
      });
    }

    const payloads = result.payloads ?? [];
    return await deliverAgentCommandResult({
      cfg,
      deps,
      runtime,
      opts,
      sessionEntry,
      result,
      payloads,
    });
  } finally {
    clearAgentRunContext(runId);
  }
}
