import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  codexChannelLoginRuntime,
  type ModelsAuthLoginFlowOptions,
} from "../../plugin-sdk/provider-auth-login-flow-runtime.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import type { ReplyPayload } from "../types.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const PRIVATE_CHAT_TYPES = new Set(["direct", "dm", "im", "private"]);
const PUBLIC_CHAT_TYPES = new Set(["channel", "forum", "group", "public", "supergroup", "topic"]);
const WEB_LOGIN_SURFACES = new Set(["control", "control-ui", "dashboard", "internal", "web"]);

const activeCodexLoginFlows = new Map<string, { expiresAt: number }>();

type RunLoginFlow = (opts: ModelsAuthLoginFlowOptions) => Promise<unknown>;

const LOGIN_COMPLETE_MESSAGE = "Codex login complete. Try your request again now.";
const LOGIN_SESSION_SWITCH_FAILED_MESSAGE =
  "Codex login completed, but this session could not switch to the newly authenticated profile. Retry `/login codex`, or select the profile manually.";

function parseLoginCommand(commandBodyNormalized: string): { providerInput: string } | null {
  const match = commandBodyNormalized.trim().match(/^\/login(?:\s+(.+))?$/u);
  if (!match) {
    return null;
  }
  const providerInput = match[1]?.trim() || "codex";
  return { providerInput };
}

function hasInternalAdminScope(params: HandleCommandsParams): boolean {
  return (
    Array.isArray(params.ctx.GatewayClientScopes) &&
    params.ctx.GatewayClientScopes.includes("operator.admin")
  );
}

function canStartCodexLogin(params: HandleCommandsParams): boolean {
  return (
    params.command.isAuthorizedSender &&
    params.command.senderIsOwner &&
    (codexChannelLoginRuntime.hasConfiguredCommandOwnerAllowlist(params.cfg) ||
      hasInternalAdminScope(params))
  );
}

function normalizeSurface(value: unknown): string {
  return normalizeLowercaseStringOrEmpty(normalizeOptionalString(value) ?? "").replace(/_/gu, "-");
}

function hasPrivateTarget(value: unknown): boolean {
  const normalized = normalizeSurface(value);
  return /^(?:direct|dm|im|private|user):/u.test(normalized);
}

function hasPublicTarget(value: unknown): boolean {
  const normalized = normalizeSurface(value);
  return /^(?:channel|forum|group|guild|public|room|topic):/u.test(normalized);
}

function isPrivateLoginContext(params: HandleCommandsParams): boolean {
  const surface = normalizeSurface(
    params.command.channel || params.command.surface || params.ctx.Surface,
  );
  if (WEB_LOGIN_SURFACES.has(surface)) {
    return true;
  }
  if (params.isGroup) {
    return false;
  }
  const chatType = normalizeSurface(params.ctx.ChatType);
  if (PRIVATE_CHAT_TYPES.has(chatType)) {
    return true;
  }
  if (PUBLIC_CHAT_TYPES.has(chatType)) {
    return false;
  }
  const targets = [
    params.ctx.OriginatingTo,
    params.ctx.To,
    params.command.to,
    params.command.from,
    params.ctx.From,
  ];
  if (targets.some(hasPrivateTarget)) {
    return true;
  }
  if (targets.some(hasPublicTarget)) {
    return false;
  }
  return false;
}

function keyPart(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value.trim() || fallback;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

function buildCodexLoginFlowKey(params: HandleCommandsParams, provider: string): string {
  const threadId =
    params.ctx.MessageThreadId ?? params.ctx.TransportThreadId ?? params.ctx.ThreadParentId;
  return [
    "channel-login",
    keyPart(params.command.channel || params.ctx.Surface || params.ctx.Provider, "unknown"),
    keyPart(params.command.accountId ?? params.ctx.AccountId, "default"),
    keyPart(params.ctx.OriginatingTo ?? params.command.to ?? params.command.channelId, "unknown"),
    keyPart(threadId, "main"),
    keyPart(
      params.agentId ??
        resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg }),
      "main",
    ),
    provider,
  ].join(":");
}

function resolveLoginAgentId(params: HandleCommandsParams): string | undefined {
  return (
    normalizeOptionalString(params.agentId) ??
    (params.sessionKey
      ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
      : undefined)
  );
}

async function emitLoginMessage(params: HandleCommandsParams, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  if (params.opts?.onBlockReply) {
    await params.opts.onBlockReply({ text: trimmed });
    return;
  }
  throw new Error("Channel /login requires immediate block delivery for device codes.");
}

async function switchLoginSessionProfile(params: {
  commandParams: HandleCommandsParams;
  nextProfileId: string | undefined;
}): Promise<"unchanged" | "updated" | "failed"> {
  const { commandParams, nextProfileId } = params;
  const currentEntry = commandParams.sessionEntry;
  if (!currentEntry || !nextProfileId) {
    return "unchanged";
  }
  const needsUpdate =
    currentEntry.authProfileOverride !== nextProfileId ||
    currentEntry.authProfileOverrideSource !== "user" ||
    currentEntry.authProfileOverrideCompactionCount !== undefined;

  const sessionStore = commandParams.sessionStore;
  if (!sessionStore) {
    return "failed";
  }
  const liveEntry = sessionStore[commandParams.sessionKey];
  const matchesLoginSnapshot = (entry: SessionEntry): boolean =>
    entry.sessionId === currentEntry.sessionId &&
    entry.authProfileOverride === currentEntry.authProfileOverride &&
    entry.authProfileOverrideSource === currentEntry.authProfileOverrideSource &&
    entry.authProfileOverrideCompactionCount === currentEntry.authProfileOverrideCompactionCount;
  if (!liveEntry || !matchesLoginSnapshot(liveEntry)) {
    return "failed";
  }

  const nextEntry = {
    ...liveEntry,
    authProfileOverride: nextProfileId,
    authProfileOverrideSource: "user" as const,
  };
  delete nextEntry.authProfileOverrideCompactionCount;
  try {
    let persistedEntry: SessionEntry = nextEntry;
    if (commandParams.storePath) {
      let snapshotMatched = false;
      const persisted = await updateSessionEntry(
        {
          storePath: commandParams.storePath,
          sessionKey: commandParams.sessionKey,
        },
        (entry) => {
          if (!matchesLoginSnapshot(entry)) {
            return null;
          }
          snapshotMatched = true;
          return needsUpdate
            ? {
                authProfileOverride: nextProfileId,
                authProfileOverrideSource: "user",
                authProfileOverrideCompactionCount: undefined,
              }
            : null;
        },
        {
          requireWriteSuccess: true,
          skipMaintenance: true,
        },
      );
      if (
        !snapshotMatched ||
        !persisted ||
        persisted.authProfileOverride !== nextProfileId ||
        persisted.authProfileOverrideSource !== "user" ||
        persisted.authProfileOverrideCompactionCount !== undefined
      ) {
        return "failed";
      }
      persistedEntry = persisted;
    }
    commandParams.sessionEntry = persistedEntry;
    sessionStore[commandParams.sessionKey] = persistedEntry;
    if (needsUpdate) {
      markCommandSessionMetadataChanged(commandParams);
      return "updated";
    }
    return "unchanged";
  } catch {
    // Credential persistence already succeeded, so report partial success.
  }
  return "failed";
}

async function runChannelCodexLogin(params: {
  commandParams: HandleCommandsParams;
  provider: string;
  agentId: string;
  runLoginFlow?: RunLoginFlow;
  runtime?: RuntimeEnv;
}): Promise<ReplyPayload> {
  const flowKey = buildCodexLoginFlowKey(params.commandParams, params.provider);
  if (!params.commandParams.opts?.onBlockReply) {
    return {
      text: "Codex login needs a live private response path so the code can be shown before it expires. Use the Web UI or a private chat and send `/login codex` again.",
    };
  }

  const reservation = codexChannelLoginRuntime.reserveFlow({
    flows: activeCodexLoginFlows,
    flowKey,
  });
  if (reservation.status === "active") {
    return {
      text: "A Codex login code is already active for this chat or channel. Complete it, or wait for it to expire before requesting a new one.",
    };
  }

  try {
    const loginResult = await codexChannelLoginRuntime.runDeviceLoginFlow({
      provider: params.provider,
      agentId: params.agentId,
      config: params.commandParams.cfg,
      runtime: params.runtime ?? defaultRuntime,
      sendMessage: async (text) => await emitLoginMessage(params.commandParams, text),
      unsupportedPromptMessage: "Channel /login supports only fixed Codex device-code auth.",
      runLoginFlow: params.runLoginFlow,
    });
    const nextProfileId = loginResult.profiles.find(
      (profile) => profile.provider === params.provider,
    )?.profileId;
    if (!nextProfileId) {
      return { text: LOGIN_SESSION_SWITCH_FAILED_MESSAGE };
    }
    const switchResult = await switchLoginSessionProfile({
      commandParams: params.commandParams,
      nextProfileId,
    });
    return {
      text:
        switchResult === "failed" ? LOGIN_SESSION_SWITCH_FAILED_MESSAGE : LOGIN_COMPLETE_MESSAGE,
    };
  } catch {
    return { text: "Codex login did not complete. Send `/login codex` to request a new code." };
  } finally {
    codexChannelLoginRuntime.releaseFlow({
      flows: activeCodexLoginFlows,
      flowKey,
      record: reservation.record,
    });
  }
}

export const handleLoginCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseLoginCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }

  if (!canStartCodexLogin(params)) {
    return {
      shouldContinue: false,
      reply: {
        text: "Only a configured OpenClaw owner/admin can start Codex login from this channel.",
      },
    };
  }

  const provider = codexChannelLoginRuntime.resolveProvider(parsed.providerInput);
  if (!provider) {
    return {
      shouldContinue: false,
      reply: { text: "Unsupported login provider. Use `/login codex`." },
    };
  }

  const agentId = resolveLoginAgentId(params);
  if (!agentId) {
    return {
      shouldContinue: false,
      reply: {
        text: "Codex login is unavailable because the active agent could not be resolved.",
      },
    };
  }
  if (!isPrivateLoginContext(params)) {
    return {
      shouldContinue: false,
      reply: {
        text: "Codex login codes are only sent in a private chat or Web UI session. Open a private chat with OpenClaw and send `/login codex` there.",
      },
    };
  }

  const reply = await runChannelCodexLogin({
    commandParams: params,
    provider,
    agentId,
  });
  return { shouldContinue: false, reply };
};

export const testing = {
  clearActiveFlows() {
    activeCodexLoginFlows.clear();
  },
  resolveCodexLoginProvider: codexChannelLoginRuntime.resolveProvider,
};
