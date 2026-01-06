import {
  ensureAuthProfileStore,
  listProfilesForProvider,
} from "../../agents/auth-profiles.js";
import {
  getCustomProviderApiKey,
  resolveEnvApiKey,
} from "../../agents/model-auth.js";
import {
  abortEmbeddedPiRun,
  compactEmbeddedPiSession,
  isEmbeddedPiRunActive,
  waitForEmbeddedPiRunEnd,
} from "../../agents/pi-embedded.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  resolveSessionTranscriptPath,
  type SessionEntry,
  type SessionScope,
  saveSessionStore,
} from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { triggerClawdbotRestart } from "../../infra/restart.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { normalizeE164 } from "../../utils.js";
import { resolveHeartbeatSeconds } from "../../web/reconnect.js";
import { getWebAuthAgeMs, webAuthExists } from "../../web/session.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import {
  normalizeGroupActivation,
  parseActivationCommand,
} from "../group-activation.js";
import { parseSendPolicyCommand } from "../send-policy.js";
import {
  buildHelpMessage,
  buildStatusMessage,
  formatContextUsageShort,
  formatTokenCount,
} from "../status.js";
import type { MsgContext } from "../templating.js";
import type { ElevatedLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { isAbortTrigger, setAbortMemory } from "./abort.js";
import type { InlineDirectives } from "./directive-handling.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { incrementCompactionCount } from "./session-updates.js";

export type CommandContext = {
  surface: string;
  isWhatsAppSurface: boolean;
  ownerList: string[];
  isAuthorizedSender: boolean;
  senderE164?: string;
  abortKey?: string;
  rawBodyNormalized: string;
  commandBodyNormalized: string;
  from?: string;
  to?: string;
};

function resolveModelAuthLabel(
  provider?: string,
  cfg?: ClawdbotConfig,
): string | undefined {
  const resolved = provider?.trim();
  if (!resolved) return undefined;

  const store = ensureAuthProfileStore();
  const profiles = listProfilesForProvider(store, resolved);
  if (profiles.length > 0) {
    const modes = new Set(
      profiles
        .map((id) => store.profiles[id]?.type)
        .filter((mode): mode is "api_key" | "oauth" => Boolean(mode)),
    );
    if (modes.has("oauth") && modes.has("api_key")) return "mixed";
    if (modes.has("oauth")) return "oauth";
    if (modes.has("api_key")) return "api-key";
  }

  const envKey = resolveEnvApiKey(resolved);
  if (envKey?.apiKey) {
    return envKey.source.includes("OAUTH_TOKEN") ? "oauth" : "api-key";
  }

  if (getCustomProviderApiKey(cfg, resolved)) return "api-key";

  return "unknown";
}

function extractCompactInstructions(params: {
  rawBody?: string;
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  isGroup: boolean;
}): string | undefined {
  const raw = stripStructuralPrefixes(params.rawBody ?? "");
  const stripped = params.isGroup
    ? stripMentions(raw, params.ctx, params.cfg)
    : raw;
  const trimmed = stripped.trim();
  if (!trimmed) return undefined;
  const lowered = trimmed.toLowerCase();
  const prefix = lowered.startsWith("/compact") ? "/compact" : null;
  if (!prefix) return undefined;
  let rest = trimmed.slice(prefix.length).trimStart();
  if (rest.startsWith(":")) rest = rest.slice(1).trimStart();
  return rest.length ? rest : undefined;
}

export function buildCommandContext(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  sessionKey?: string;
  isGroup: boolean;
  triggerBodyNormalized: string;
  commandAuthorized: boolean;
}): CommandContext {
  const { ctx, cfg, sessionKey, isGroup, triggerBodyNormalized } = params;
  const auth = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized: params.commandAuthorized,
  });
  const surface = (ctx.Surface ?? "").trim().toLowerCase();
  const abortKey =
    sessionKey ?? (auth.from || undefined) ?? (auth.to || undefined);
  const rawBodyNormalized = triggerBodyNormalized;
  const commandBodyNormalized = isGroup
    ? stripMentions(rawBodyNormalized, ctx, cfg)
    : rawBodyNormalized;

  return {
    surface,
    isWhatsAppSurface: auth.isWhatsAppSurface,
    ownerList: auth.ownerList,
    isAuthorizedSender: auth.isAuthorizedSender,
    senderE164: auth.senderE164,
    abortKey,
    rawBodyNormalized,
    commandBodyNormalized,
    from: auth.from,
    to: auth.to,
  };
}

export async function handleCommands(params: {
  ctx: MsgContext;
  cfg: ClawdbotConfig;
  command: CommandContext;
  directives: InlineDirectives;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  sessionScope?: SessionScope;
  workspaceDir: string;
  defaultGroupActivation: () => "always" | "mention";
  resolvedThinkLevel?: ThinkLevel;
  resolvedVerboseLevel: VerboseLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  provider: string;
  model: string;
  contextTokens: number;
  isGroup: boolean;
}): Promise<{
  reply?: ReplyPayload;
  shouldContinue: boolean;
}> {
  const {
    ctx,
    cfg,
    command,
    directives,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    defaultGroupActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    isGroup,
  } = params;

  const resetRequested =
    command.commandBodyNormalized === "/reset" ||
    command.commandBodyNormalized === "/new";
  if (resetRequested && !command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /reset from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const activationCommand = parseActivationCommand(
    command.commandBodyNormalized,
  );
  const sendPolicyCommand = parseSendPolicyCommand(
    command.commandBodyNormalized,
  );

  if (activationCommand.hasCommand) {
    if (!isGroup) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Group activation only applies to group chats." },
      };
    }
    const activationOwnerList = command.ownerList;
    const activationSenderE164 = command.senderE164
      ? normalizeE164(command.senderE164)
      : "";
    const isActivationOwner =
      !command.isWhatsAppSurface || activationOwnerList.length === 0
        ? command.isAuthorizedSender
        : Boolean(activationSenderE164) &&
          activationOwnerList.includes(activationSenderE164);

    if (
      !command.isAuthorizedSender ||
      (command.isWhatsAppSurface && !isActivationOwner)
    ) {
      logVerbose(
        `Ignoring /activation from unauthorized sender in group: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (!activationCommand.mode) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Usage: /activation mention|always" },
      };
    }
    if (sessionEntry && sessionStore && sessionKey) {
      sessionEntry.groupActivation = activationCommand.mode;
      sessionEntry.groupActivationNeedsSystemIntro = true;
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    }
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Group activation set to ${activationCommand.mode}.` },
    };
  }

  if (sendPolicyCommand.hasCommand) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /send from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (!sendPolicyCommand.mode) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Usage: /send on|off|inherit" },
      };
    }
    if (sessionEntry && sessionStore && sessionKey) {
      if (sendPolicyCommand.mode === "inherit") {
        delete sessionEntry.sendPolicy;
      } else {
        sessionEntry.sendPolicy = sendPolicyCommand.mode;
      }
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    }
    const label =
      sendPolicyCommand.mode === "inherit"
        ? "inherit"
        : sendPolicyCommand.mode === "allow"
          ? "on"
          : "off";
    return {
      shouldContinue: false,
      reply: { text: `⚙️ Send policy set to ${label}.` },
    };
  }

  if (
    command.commandBodyNormalized === "/restart" ||
    command.commandBodyNormalized.startsWith("/restart ")
  ) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /restart from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    const restartMethod = triggerClawdbotRestart();
    return {
      shouldContinue: false,
      reply: {
        text: `⚙️ Restarting clawdbot via ${restartMethod}; give me a few seconds to come back online.`,
      },
    };
  }

  const helpRequested =
    command.commandBodyNormalized === "/help" ||
    /(?:^|\s)\/help(?=$|\s|:)\b/i.test(command.commandBodyNormalized);
  if (helpRequested) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /help from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    return { shouldContinue: false, reply: { text: buildHelpMessage() } };
  }

  const statusRequested =
    directives.hasStatusDirective ||
    command.commandBodyNormalized === "/status" ||
    command.commandBodyNormalized.startsWith("/status ");
  if (statusRequested) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /status from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    const webLinked = await webAuthExists();
    const webAuthAgeMs = getWebAuthAgeMs();
    const heartbeatSeconds = resolveHeartbeatSeconds(cfg, undefined);
    const groupActivation = isGroup
      ? (normalizeGroupActivation(sessionEntry?.groupActivation) ??
        defaultGroupActivation())
      : undefined;
    const statusText = buildStatusMessage({
      agent: {
        ...cfg.agent,
        model: {
          ...cfg.agent?.model,
          primary: model,
        },
        contextTokens,
        thinkingDefault: cfg.agent?.thinkingDefault,
        verboseDefault: cfg.agent?.verboseDefault,
        elevatedDefault: cfg.agent?.elevatedDefault,
      },
      workspaceDir,
      sessionEntry,
      sessionKey,
      sessionScope,
      storePath,
      groupActivation,
      resolvedThink:
        resolvedThinkLevel ?? (await resolveDefaultThinkingLevel()),
      resolvedVerbose: resolvedVerboseLevel,
      resolvedElevated: resolvedElevatedLevel,
      modelAuth: resolveModelAuthLabel(provider, cfg),
      webLinked,
      webAuthAgeMs,
      heartbeatSeconds,
    });
    return { shouldContinue: false, reply: { text: statusText } };
  }

  const compactRequested =
    command.commandBodyNormalized === "/compact" ||
    command.commandBodyNormalized.startsWith("/compact ");
  if (compactRequested) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /compact from unauthorized sender: ${command.senderE164 || "<unknown>"}`,
      );
      return { shouldContinue: false };
    }
    if (!sessionEntry?.sessionId) {
      return {
        shouldContinue: false,
        reply: { text: "⚙️ Compaction unavailable (missing session id)." },
      };
    }
    const sessionId = sessionEntry.sessionId;
    if (isEmbeddedPiRunActive(sessionId)) {
      abortEmbeddedPiRun(sessionId);
      await waitForEmbeddedPiRunEnd(sessionId, 15_000);
    }
    const customInstructions = extractCompactInstructions({
      rawBody: ctx.Body,
      ctx,
      cfg,
      isGroup,
    });
    const result = await compactEmbeddedPiSession({
      sessionId,
      sessionKey,
      surface: command.surface,
      sessionFile: resolveSessionTranscriptPath(sessionId),
      workspaceDir,
      config: cfg,
      skillsSnapshot: sessionEntry.skillsSnapshot,
      provider,
      model,
      thinkLevel: resolvedThinkLevel ?? (await resolveDefaultThinkingLevel()),
      bashElevated: {
        enabled: false,
        allowed: false,
        defaultLevel: "off",
      },
      customInstructions,
      ownerNumbers:
        command.ownerList.length > 0 ? command.ownerList : undefined,
    });

    const totalTokens =
      sessionEntry.totalTokens ??
      (sessionEntry.inputTokens ?? 0) + (sessionEntry.outputTokens ?? 0);
    const contextSummary = formatContextUsageShort(
      totalTokens > 0 ? totalTokens : null,
      contextTokens ?? sessionEntry.contextTokens ?? null,
    );
    const compactLabel = result.ok
      ? result.compacted
        ? result.result?.tokensBefore
          ? `Compacted (${formatTokenCount(result.result.tokensBefore)} before)`
          : "Compacted"
        : "Compaction skipped"
      : "Compaction failed";
    if (result.ok && result.compacted) {
      await incrementCompactionCount({
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });
    }
    const reason = result.reason?.trim();
    const line = reason
      ? `${compactLabel}: ${reason} • ${contextSummary}`
      : `${compactLabel} • ${contextSummary}`;
    enqueueSystemEvent(line);
    return { shouldContinue: false, reply: { text: `⚙️ ${line}` } };
  }

  const abortRequested = isAbortTrigger(command.rawBodyNormalized);
  if (abortRequested) {
    if (sessionEntry && sessionStore && sessionKey) {
      sessionEntry.abortedLastRun = true;
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await saveSessionStore(storePath, sessionStore);
      }
    } else if (command.abortKey) {
      setAbortMemory(command.abortKey, true);
    }
    return { shouldContinue: false, reply: { text: "⚙️ Agent was aborted." } };
  }

  const sendPolicy = resolveSendPolicy({
    cfg,
    entry: sessionEntry,
    sessionKey,
    surface: sessionEntry?.surface ?? command.surface,
    chatType: sessionEntry?.chatType,
  });
  if (sendPolicy === "deny") {
    logVerbose(`Send blocked by policy for session ${sessionKey ?? "unknown"}`);
    return { shouldContinue: false };
  }

  return { shouldContinue: true };
}
