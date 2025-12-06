import crypto from "node:crypto";
import { chunkText } from "../auto-reply/chunk.js";
import { runCommandReply } from "../auto-reply/command-reply.js";
import {
  applyTemplate,
  type MsgContext,
  type TemplateContext,
} from "../auto-reply/templating.js";
import {
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../auto-reply/thinking.js";
import { type CliDeps, createDefaultDeps } from "../cli/deps.js";
import { loadConfig, type WarelayConfig } from "../config/config.js";
import {
  DEFAULT_IDLE_MINUTES,
  deriveSessionKey,
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../config/sessions.js";
import { readEnv } from "../env.js";
import { ensureTwilioEnv } from "../env.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { pickProvider } from "../provider-web.js";
import { createInitializedProvider } from "../providers/factory.js";
import type { TelegramProviderConfig } from "../providers/base/types.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { Provider } from "../utils.js";
import { sendViaIpc } from "../web/ipc.js";

type AgentCommandOpts = {
  message: string;
  to?: string;
  sessionId?: string;
  thinking?: string;
  verbose?: string;
  json?: boolean;
  timeout?: string;
  deliver?: boolean;
  provider?: Provider | "auto";
};

type SessionResolution = {
  sessionId: string;
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  isNewSession: boolean;
  systemSent: boolean;
  persistedThinking?: ThinkLevel;
  persistedVerbose?: VerboseLevel;
};

function assertCommandConfig(cfg: WarelayConfig) {
  const reply = cfg.inbound?.reply;
  if (!reply || reply.mode !== "command" || !reply.command?.length) {
    throw new Error(
      "Configure inbound.reply.mode=command with reply.command before using `warelay agent`.",
    );
  }
  return reply as NonNullable<
    NonNullable<WarelayConfig["inbound"]>["reply"]
  > & { mode: "command"; command: string[] };
}

async function resolveSession(opts: {
  to?: string;
  sessionId?: string;
  replyCfg: NonNullable<NonNullable<WarelayConfig["inbound"]>["reply"]>;
}): Promise<SessionResolution> {
  const sessionCfg = opts.replyCfg?.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const idleMinutes = Math.max(
    sessionCfg?.idleMinutes ?? DEFAULT_IDLE_MINUTES,
    1,
  );
  const idleMs = idleMinutes * 60_000;
  const storePath = sessionCfg ? resolveStorePath(sessionCfg.store) : undefined;
  const sessionStore = storePath ? loadSessionStore(storePath) : undefined;
  const now = Date.now();

  let sessionKey: string | undefined =
    sessionStore && opts.to
      ? await deriveSessionKey(scope, { From: opts.to } as MsgContext)
      : undefined;
  let sessionEntry =
    sessionKey && sessionStore ? sessionStore[sessionKey] : undefined;

  // If a session id was provided, prefer to re-use its entry (by id) even when no key was derived.
  if (
    sessionStore &&
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

  let sessionId = opts.sessionId?.trim() || sessionEntry?.sessionId;
  let isNewSession = false;
  let systemSent = sessionEntry?.systemSent ?? false;

  if (!opts.sessionId) {
    const fresh = sessionEntry && sessionEntry.updatedAt >= now - idleMs;
    if (!sessionEntry || !fresh) {
      sessionId = sessionId ?? crypto.randomUUID();
      isNewSession = true;
      systemSent = false;
      if (sessionCfg && sessionStore && sessionKey) {
        sessionEntry = {
          sessionId,
          updatedAt: now,
          abortedLastRun: sessionEntry?.abortedLastRun,
        };
      }
    }
  } else {
    sessionId = sessionId ?? crypto.randomUUID();
    isNewSession = false;
    if (!sessionEntry && sessionCfg && sessionStore && sessionKey) {
      sessionEntry = {
        sessionId,
        updatedAt: now,
      };
    }
  }

  const persistedThinking =
    !isNewSession && sessionEntry
      ? normalizeThinkLevel(sessionEntry.thinkingLevel)
      : undefined;
  const persistedVerbose =
    !isNewSession && sessionEntry
      ? normalizeVerboseLevel(sessionEntry.verboseLevel)
      : undefined;

  return {
    sessionId: sessionId ?? crypto.randomUUID(),
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    isNewSession,
    systemSent,
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
  if (!body) {
    throw new Error("Message (--message) is required");
  }
  if (!opts.to && !opts.sessionId) {
    throw new Error("Pass --to <E.164> or --session-id to choose a session");
  }
  if (opts.deliver && !opts.to) {
    throw new Error("Delivering to WhatsApp requires --to <E.164>");
  }

  const cfg = loadConfig();
  const replyCfg = assertCommandConfig(cfg);
  const sessionCfg = replyCfg.session;

  const thinkOverride = normalizeThinkLevel(opts.thinking);
  if (opts.thinking && !thinkOverride) {
    throw new Error(
      "Invalid thinking level. Use one of: off, minimal, low, medium, high.",
    );
  }
  const verboseOverride = normalizeVerboseLevel(opts.verbose);
  if (opts.verbose && !verboseOverride) {
    throw new Error('Invalid verbose level. Use "on" or "off".');
  }

  const timeoutSecondsRaw =
    opts.timeout !== undefined
      ? Number.parseInt(String(opts.timeout), 10)
      : (replyCfg.timeoutSeconds ?? 600);
  const timeoutSeconds = Math.max(timeoutSecondsRaw, 1);
  if (Number.isNaN(timeoutSecondsRaw) || timeoutSecondsRaw <= 0) {
    throw new Error("--timeout must be a positive integer (seconds)");
  }
  const timeoutMs = timeoutSeconds * 1000;

  const sessionResolution = await resolveSession({
    to: opts.to,
    sessionId: opts.sessionId,
    replyCfg,
  });
  const {
    sessionId,
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    isNewSession,
    systemSent: initialSystemSent,
    persistedThinking,
    persistedVerbose,
  } = sessionResolution;

  let systemSent = initialSystemSent;
  const sendSystemOnce = sessionCfg?.sendSystemOnce === true;
  const isFirstTurnInSession = isNewSession || !systemSent;

  // Merge thinking/verbose levels: flag override > persisted > defaults.
  const resolvedThinkLevel: ThinkLevel | undefined =
    thinkOverride ??
    persistedThinking ??
    (replyCfg.thinkingDefault as ThinkLevel | undefined);
  const resolvedVerboseLevel: VerboseLevel | undefined =
    verboseOverride ??
    persistedVerbose ??
    (replyCfg.verboseDefault as VerboseLevel | undefined);

  // Persist overrides into the session store (mirrors directive-only flow).
  if (sessionStore && sessionEntry && sessionKey && storePath) {
    sessionEntry.updatedAt = Date.now();
    if (thinkOverride) {
      if (thinkOverride === "off") {
        delete sessionEntry.thinkingLevel;
      } else {
        sessionEntry.thinkingLevel = thinkOverride;
      }
    } else if (isNewSession) {
      delete sessionEntry.thinkingLevel;
    }

    if (verboseOverride) {
      if (verboseOverride === "off") {
        delete sessionEntry.verboseLevel;
      } else {
        sessionEntry.verboseLevel = verboseOverride;
      }
    } else if (isNewSession) {
      delete sessionEntry.verboseLevel;
    }

    if (sendSystemOnce && isFirstTurnInSession) {
      sessionEntry.systemSent = true;
      systemSent = true;
    }

    sessionStore[sessionKey] = sessionEntry;
    await saveSessionStore(storePath, sessionStore);
  }

  const baseCtx: TemplateContext = {
    Body: body,
    BodyStripped: body,
    From: opts.to,
    SessionId: sessionId,
    IsNewSession: isNewSession ? "true" : "false",
  };

  const sessionIntro =
    isFirstTurnInSession && sessionCfg?.sessionIntro
      ? applyTemplate(sessionCfg.sessionIntro, baseCtx)
      : "";
  const bodyPrefix = replyCfg.bodyPrefix
    ? applyTemplate(replyCfg.bodyPrefix, baseCtx)
    : "";

  let commandBody = body;
  if (!sendSystemOnce || isFirstTurnInSession) {
    commandBody = bodyPrefix ? `${bodyPrefix}${commandBody}` : commandBody;
  }
  if (sessionIntro) {
    commandBody = `${sessionIntro}\n\n${commandBody}`;
  }

  const templatingCtx: TemplateContext = {
    ...baseCtx,
    Body: commandBody,
    BodyStripped: commandBody,
  };

  const result = await runCommandReply({
    reply: { ...replyCfg, mode: "command" },
    templatingCtx,
    sendSystemOnce,
    isNewSession,
    isFirstTurnInSession,
    systemSent,
    timeoutMs,
    timeoutSeconds,
    commandRunner: runCommandWithTimeout,
    thinkLevel: resolvedThinkLevel,
    verboseLevel: resolvedVerboseLevel,
  });

  // If the agent returned a new session id, persist it.
  const returnedSessionId = result.meta.agentMeta?.sessionId;
  if (
    returnedSessionId &&
    returnedSessionId !== sessionId &&
    sessionStore &&
    sessionEntry &&
    sessionKey &&
    storePath
  ) {
    sessionEntry.sessionId = returnedSessionId;
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    await saveSessionStore(storePath, sessionStore);
  }

  const payloads = result.payloads ?? [];
  if (opts.json) {
    const normalizedPayloads = payloads.map((p) => ({
      text: p.text ?? "",
      mediaUrl: p.mediaUrl ?? null,
      mediaUrls: p.mediaUrls ?? (p.mediaUrl ? [p.mediaUrl] : undefined),
    }));
    runtime.log(
      JSON.stringify(
        {
          payloads: normalizedPayloads,
          meta: result.meta,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (payloads.length === 0) {
    runtime.log("No reply from agent.");
    return;
  }

  const deliver = opts.deliver === true;
  let provider: Provider | "auto" | undefined = opts.provider ?? "auto";
  if (deliver) {
    provider =
      provider === "twilio"
        ? "twilio"
        : provider === "telegram"
          ? "telegram"
          : await pickProvider((provider ?? "auto") as Provider | "auto");
    if (provider === "twilio") ensureTwilioEnv();
  }

  for (const payload of payloads) {
    const lines: string[] = [];
    if (payload.text) lines.push(payload.text.trimEnd());
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    for (const url of mediaList) {
      lines.push(`MEDIA:${url}`);
    }
    runtime.log(lines.join("\n"));

    if (deliver && opts.to) {
      const text = payload.text ?? "";
      const media = mediaList;
      if (provider === "web") {
        // Prefer IPC to reuse the running relay; fall back to direct web send.
        let sentViaIpc = false;
        const ipcResult = await sendViaIpc(opts.to, text, media[0]);
        if (ipcResult) {
          sentViaIpc = ipcResult.success;
          if (ipcResult.success && media.length > 1) {
            for (const extra of media.slice(1)) {
              await sendViaIpc(opts.to, "", extra);
            }
          }
        }
        if (!sentViaIpc) {
          if (text || media.length === 0) {
            await deps.sendMessageWeb(opts.to, text, {
              verbose: false,
              mediaUrl: media[0],
            });
          }
          for (const extra of media.slice(1)) {
            await deps.sendMessageWeb(opts.to, "", {
              verbose: false,
              mediaUrl: extra,
            });
          }
        }
      } else if (provider === "telegram") {
        const env = readEnv(runtime);
        if (!env.telegram?.apiId || !env.telegram?.apiHash) {
          throw new Error(
            "Telegram not configured. Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env",
          );
        }
        const telegramConfig: TelegramProviderConfig = {
          kind: "telegram",
          apiId: Number.parseInt(env.telegram.apiId, 10),
          apiHash: env.telegram.apiHash,
          sessionDir: undefined,
          verbose: false,
        };
        const telegramProvider =
          await createInitializedProvider("telegram", telegramConfig);
        const chunks = chunkText(text, 4096);
        if (chunks.length > 0 || media.length > 0) {
          const firstChunk = chunks.length > 0 ? chunks[0] : "";
          const firstMedia = media[0];
          await telegramProvider.send(opts.to, firstChunk, {
            media: firstMedia ? [{ type: "image", url: firstMedia }] : undefined,
          });
        }
        for (let i = 1; i < chunks.length; i++) {
          await telegramProvider.send(opts.to, chunks[i]);
        }
        for (let i = 1; i < media.length; i++) {
          await telegramProvider.send(opts.to, "", {
            media: [{ type: "image", url: media[i] }],
          });
        }
      } else {
        const chunks = chunkText(text, 1600);
        const resolvedMedia = await Promise.all(
          media.map((m) =>
            deps.resolveTwilioMediaUrl(m, { serveMedia: false, runtime }),
          ),
        );
        const firstMedia = resolvedMedia[0];
        if (chunks.length === 0) chunks.push("");
        for (let i = 0; i < chunks.length; i++) {
          const bodyChunk = chunks[i];
          const attach = i === 0 ? firstMedia : undefined;
          await deps.sendMessage(
            opts.to,
            bodyChunk,
            { mediaUrl: attach },
            runtime,
          );
        }
        if (resolvedMedia.length > 1) {
          for (const extra of resolvedMedia.slice(1)) {
            await deps.sendMessage(opts.to, "", { mediaUrl: extra }, runtime);
          }
        }
      }
    }
  }
}
