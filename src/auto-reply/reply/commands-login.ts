import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  decideProviderLoginSessionAdoption,
  createProviderLoginFlowRegistry,
  formatProviderLoginChoices,
  formatProviderLoginCommand,
  formatProviderLoginComplete,
  formatProviderLoginControlUiHandoff,
  formatProviderLoginFailed,
  formatProviderLoginSessionSwitchFailed,
  hasConfiguredCommandOwnerAllowlist,
  isProviderLoginPatchPersisted,
  releaseProviderLoginFlow,
  reserveProviderLoginFlow,
  resolveProviderChannelLoginChoice,
  runProviderChannelLoginFlow,
  type ProviderChannelLoginChoice,
} from "../../plugin-sdk/provider-auth-login-flow-runtime.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import type { ReplyPayload } from "../types.js";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const PRIVATE_CHAT_TYPES = new Set(["direct", "dm", "im", "private"]);
const PUBLIC_CHAT_TYPES = new Set(["channel", "forum", "group", "public", "supergroup", "topic"]);
const WEB_LOGIN_SURFACES = new Set(["control", "control-ui", "dashboard", "internal", "web"]);

const activeProviderLoginFlows = createProviderLoginFlowRegistry();

function parseLoginCommand(
  commandBodyNormalized: string,
): { providerInput: string | undefined } | null {
  const match = commandBodyNormalized.trim().match(/^\/login(?:\s+(.+))?$/u);
  if (!match) {
    return null;
  }
  const providerInput = match[1]?.trim() || undefined;
  return { providerInput };
}

function hasInternalAdminScope(params: HandleCommandsParams): boolean {
  return (
    Array.isArray(params.ctx.GatewayClientScopes) &&
    params.ctx.GatewayClientScopes.includes("operator.admin")
  );
}

function canStartProviderLogin(params: HandleCommandsParams): boolean {
  return (
    params.command.isAuthorizedSender &&
    params.command.senderIsOwner &&
    (hasConfiguredCommandOwnerAllowlist(params.cfg) || hasInternalAdminScope(params))
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

function buildProviderLoginFlowKey(params: HandleCommandsParams, choiceId: string): string {
  const threadId =
    params.ctx.MessageThreadId ?? params.ctx.TransportThreadId ?? params.ctx.ThreadParentId;
  return [
    "channel-login",
    keyPart(params.command.channel || params.ctx.Surface || params.ctx.Provider, "unknown"),
    keyPart(params.command.accountId ?? params.ctx.AccountId, "default"),
    keyPart(params.ctx.OriginatingTo ?? params.command.to ?? params.command.channelId, "unknown"),
    keyPart(threadId, "main"),
    params.agentId,
    choiceId,
  ].join(":");
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
  loginProvider: string;
  nextProfileId: string | undefined;
}): Promise<"unchanged" | "updated" | "failed"> {
  const { commandParams, loginProvider, nextProfileId } = params;
  const currentEntry = commandParams.sessionEntry;
  if (!nextProfileId) {
    return "failed";
  }
  if (!currentEntry) {
    return "unchanged";
  }
  if (normalizeSurface(commandParams.provider) !== normalizeSurface(loginProvider)) {
    return "unchanged";
  }

  const sessionStore = commandParams.sessionStore;
  if (!sessionStore) {
    return "failed";
  }
  const liveEntry = sessionStore[commandParams.sessionKey];
  if (!liveEntry) {
    return "failed";
  }
  const liveDecision = decideProviderLoginSessionAdoption({
    currentModelProvider: commandParams.provider,
    loginProvider,
    nextProfileId,
    snapshot: currentEntry,
    current: liveEntry,
  });
  if (liveDecision.status === "rejected") {
    return "failed";
  }
  if (liveDecision.status === "unchanged" && !commandParams.storePath) {
    return "unchanged";
  }

  const nextEntry =
    liveDecision.status === "patch" ? { ...liveEntry, ...liveDecision.patch } : liveEntry;
  delete nextEntry.authProfileOverrideCompactionCount;
  try {
    let finalDecision = liveDecision;
    let persistedEntry: SessionEntry = nextEntry;
    if (commandParams.storePath) {
      let persistedDecision: ReturnType<typeof decideProviderLoginSessionAdoption> | undefined;
      const persisted = await updateSessionEntry(
        {
          storePath: commandParams.storePath,
          sessionKey: commandParams.sessionKey,
        },
        (entry) => {
          persistedDecision = decideProviderLoginSessionAdoption({
            currentModelProvider: commandParams.provider,
            loginProvider,
            nextProfileId,
            snapshot: currentEntry,
            current: entry,
          });
          return persistedDecision.status === "patch" ? persistedDecision.patch : null;
        },
        {
          requireWriteSuccess: true,
          skipMaintenance: true,
        },
      );
      if (
        !persistedDecision ||
        persistedDecision.status === "rejected" ||
        !persisted ||
        (persistedDecision.status === "patch" &&
          !isProviderLoginPatchPersisted(persisted, nextProfileId))
      ) {
        return "failed";
      }
      finalDecision = persistedDecision;
      persistedEntry = persisted;
    }
    commandParams.sessionEntry = persistedEntry;
    sessionStore[commandParams.sessionKey] = persistedEntry;
    if (finalDecision.status === "patch") {
      markCommandSessionMetadataChanged(commandParams);
      return "updated";
    }
    return "unchanged";
  } catch {
    // Credential persistence already succeeded, so report partial success.
  }
  return "failed";
}

async function runChannelProviderLogin(params: {
  commandParams: HandleCommandsParams;
  choice: ProviderChannelLoginChoice;
  agentId: string;
  runtime?: RuntimeEnv;
}): Promise<ReplyPayload> {
  const flowKey = buildProviderLoginFlowKey(params.commandParams, params.choice.choiceId);
  if (!params.commandParams.opts?.onBlockReply) {
    return {
      text: `${params.choice.providerLabel} login needs a live private response path so the code can be shown before it expires. Use the Control UI or a private chat and send \`${formatProviderLoginCommand(params.choice)}\` again.`,
    };
  }

  const reservation = reserveProviderLoginFlow({
    flows: activeProviderLoginFlows,
    flowKey,
  });
  if (reservation.status === "active") {
    return {
      text: `${params.choice.providerLabel} login is already active for this chat or channel. Complete it, or wait for it to expire before requesting a new one.`,
    };
  }

  try {
    const loginResult = await runProviderChannelLoginFlow({
      choice: params.choice,
      agentId: params.agentId,
      config: params.commandParams.cfg,
      runtime: params.runtime ?? defaultRuntime,
      signal: reservation.record.signal,
      sendMessage: async (text) => await emitLoginMessage(params.commandParams, text),
      unsupportedPromptMessage:
        "This provider needs input that chat cannot collect. Open Control UI → Models and choose Sign in.",
    });
    const nextProfileId = loginResult.profiles.find(
      (profile) =>
        normalizeSurface(profile.provider) === normalizeSurface(params.choice.providerId),
    )?.profileId;
    if (!nextProfileId) {
      return { text: formatProviderLoginSessionSwitchFailed(params.choice) };
    }
    const switchResult = await switchLoginSessionProfile({
      commandParams: params.commandParams,
      loginProvider: params.choice.providerId,
      nextProfileId,
    });
    return {
      text:
        switchResult === "failed"
          ? formatProviderLoginSessionSwitchFailed(params.choice)
          : formatProviderLoginComplete(
              params.choice,
              loginResult.imported === true,
              loginResult.modelAccess,
              loginResult.authRefresh,
            ),
    };
  } catch {
    return { text: formatProviderLoginFailed(params.choice) };
  } finally {
    releaseProviderLoginFlow({
      flows: activeProviderLoginFlows,
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

  if (!canStartProviderLogin(params)) {
    return {
      shouldContinue: false,
      reply: {
        text: "Only a configured OpenClaw owner/admin can start provider login from this channel.",
      },
    };
  }

  const resolution = resolveProviderChannelLoginChoice(parsed.providerInput, {
    config: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  if (resolution.status !== "resolved") {
    const available = formatProviderLoginChoices(resolution.choices);
    return {
      shouldContinue: false,
      reply: {
        text:
          resolution.status === "ambiguous"
            ? `Choose one provider login: ${available}.`
            : `Unsupported login provider. Available provider access commands: ${available}.`,
      },
    };
  }

  if (!isPrivateLoginContext(params)) {
    return {
      shouldContinue: false,
      reply: {
        text: `Provider login codes are only sent in a private chat or Control UI session. Open a private chat with OpenClaw and send \`${formatProviderLoginCommand(resolution.choice)}\` there.`,
      },
    };
  }

  if (resolution.choice.mode !== "chat") {
    return {
      shouldContinue: false,
      reply: { text: formatProviderLoginControlUiHandoff(resolution.choice) },
    };
  }

  const reply = await runChannelProviderLogin({
    commandParams: params,
    choice: resolution.choice,
    agentId: params.agentId,
  });
  return { shouldContinue: false, reply };
};
