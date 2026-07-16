/**
 * HTTP callback handler for Mattermost slash commands.
 *
 * Receives POST requests from Mattermost when a slash command is invoked,
 * validates the token, and routes the command through the standard inbound pipeline.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/browser-security-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import type { ResolvedMattermostAccount } from "../mattermost/accounts.js";
import { getMattermostRuntime } from "../runtime.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  sendMattermostTyping,
  type MattermostChannel,
} from "./client.js";
import {
  renderMattermostModelSummaryView,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel,
  resolveMattermostModelPickerEntry,
} from "./model-picker.js";
import {
  authorizeMattermostCommandInvocation,
  normalizeMattermostAllowList,
} from "./monitor-auth.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import {
  buildModelsProviderData,
  createChannelReplyPipeline,
  isRequestBodyLimitError,
  logTypingFailure,
  readRequestBodyWithLimit,
  type OpenClawConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";
import {
  parseSlashCommandPayload,
  resolveCommandText,
  type MattermostSlashCommandResponse,
} from "./slash-commands.js";

type SlashHttpHandlerParams = {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  /** Expected token from registered commands (for validation). */
  commandTokens: Set<string>;
  /** Map from trigger to original command name (for skill commands that start with oc_). */
  triggerMap?: ReadonlyMap<string, string>;
  log?: (msg: string) => void;
};

const MAX_BODY_BYTES = 64 * 1024;
const BODY_READ_TIMEOUT_MS = 5_000;

/**
 * Read the full request body as a string.
 */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return readRequestBodyWithLimit(req, {
    maxBytes,
    timeoutMs: BODY_READ_TIMEOUT_MS,
  });
}

function sendJsonResponse(
  res: ServerResponse,
  status: number,
  body: MattermostSlashCommandResponse,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function matchesRegisteredCommandToken(
  commandTokens: ReadonlySet<string>,
  candidate: string,
): boolean {
  for (const token of commandTokens) {
    if (safeEqualSecret(candidate, token)) {
      return true;
    }
  }
  return false;
}

type SlashInvocationAuth = {
  ok: boolean;
  denyResponse?: MattermostSlashCommandResponse;
  commandAuthorized: boolean;
  channelInfo: MattermostChannel | null;
  kind: "direct" | "group" | "channel";
  chatType: "direct" | "group" | "channel";
  channelName: string;
  channelDisplay: string;
  roomLabel: string;
};

async function authorizeSlashInvocation(params: {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  client: ReturnType<typeof createMattermostClient>;
  commandText: string;
  channelId: string;
  senderId: string;
  senderName: string;
  log?: (msg: string) => void;
}): Promise<SlashInvocationAuth> {
  const { account, cfg, client, commandText, channelId, senderId, senderName, log } = params;
  const core = getMattermostRuntime();

  // Resolve channel info so we can enforce DM vs group/channel policies.
  let channelInfo: MattermostChannel | null = null;
  try {
    channelInfo = await fetchMattermostChannel(client, channelId);
  } catch (err) {
    log?.(`mattermost: slash channel lookup failed for ${channelId}: ${String(err)}`);
  }

  if (!channelInfo) {
    return {
      ok: false,
      denyResponse: {
        response_type: "ephemeral",
        text: "Temporary error: unable to determine channel type. Please try again.",
      },
      commandAuthorized: false,
      channelInfo: null,
      kind: "channel",
      chatType: "channel",
      channelName: "",
      channelDisplay: "",
      roomLabel: `#${channelId}`,
    };
  }

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg,
    surface: "mattermost",
  });
  const hasControlCommand = core.channel.text.hasControlCommand(commandText, cfg);
  const storeAllowFrom = normalizeMattermostAllowList(
    await core.channel.pairing
      .readAllowFromStore({
        channel: "mattermost",
        accountId: account.accountId,
      })
      .catch(() => []),
  );
  const decision = authorizeMattermostCommandInvocation({
    account,
    cfg,
    senderId,
    senderName,
    channelId,
    channelInfo,
    storeAllowFrom,
    allowTextCommands,
    hasControlCommand,
  });

  if (!decision.ok) {
    if (decision.denyReason === "dm-pairing") {
      const { code } = await core.channel.pairing.upsertPairingRequest({
        channel: "mattermost",
        accountId: account.accountId,
        id: senderId,
        meta: { name: senderName },
      });
      return {
        ...decision,
        denyResponse: {
          response_type: "ephemeral",
          text: core.channel.pairing.buildPairingReply({
            channel: "mattermost",
            idLine: `Your Mattermost user id: ${senderId}`,
            code,
          }),
        },
      };
    }

    const denyText =
      decision.denyReason === "unknown-channel"
        ? "Temporary error: unable to determine channel type. Please try again."
        : decision.denyReason === "dm-disabled"
          ? "This bot is not accepting direct messages."
          : decision.denyReason === "channels-disabled"
            ? "Slash commands are disabled in channels."
            : decision.denyReason === "channel-no-allowlist"
              ? "Slash commands are not configured for this channel (no allowlist)."
              : "Unauthorized.";
    return {
      ...decision,
      denyResponse: {
        response_type: "ephemeral",
        text: denyText,
      },
    };
  }

  return {
    ...decision,
    denyResponse: undefined,
  };
}

/**
 * Create the HTTP request handler for Mattermost slash command callbacks.
 *
 * This handler is registered as a plugin HTTP route and receives POSTs
 * from the Mattermost server when a user invokes a registered slash command.
 */
export function createSlashCommandHttpHandler(params: SlashHttpHandlerParams) {
  const { account, cfg, runtime, commandTokens, triggerMap, log } = params;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }

    let body: string;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")) {
        res.statusCode = 408;
        res.end("Request body timeout");
        return;
      }
      res.statusCode = 413;
      res.end("Payload Too Large");
      return;
    }

    const contentType = req.headers["content-type"] ?? "";
    const payload = parseSlashCommandPayload(body, contentType);
    if (!payload) {
      sendJsonResponse(res, 400, {
        response_type: "ephemeral",
        text: "Invalid slash command payload.",
      });
      return;
    }

    // Validate token — fail closed: reject when no tokens are registered
    // (e.g. registration failed or startup was partial)
    if (commandTokens.size === 0 || !matchesRegisteredCommandToken(commandTokens, payload.token)) {
      sendJsonResponse(res, 401, {
        response_type: "ephemeral",
        text: "Unauthorized: invalid command token.",
      });
      return;
    }

    // Extract command info
    const trigger = payload.command.replace(/^\//, "").trim();
    const commandText = resolveCommandText(trigger, payload.text, triggerMap);
    const channelId = payload.channel_id;
    const senderId = payload.user_id;
    const senderName = payload.user_name ?? senderId;

    const client = createMattermostClient({
      baseUrl: account.baseUrl ?? "",
      botToken: account.botToken ?? "",
      allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
    });

    const auth = await authorizeSlashInvocation({
      account,
      cfg,
      client,
      commandText,
      channelId,
      senderId,
      senderName,
      log,
    });

    if (!auth.ok) {
      sendJsonResponse(
        res,
        200,
        auth.denyResponse ?? { response_type: "ephemeral", text: "Unauthorized." },
      );
      return;
    }

    log?.(`mattermost: slash command /${trigger} from ${senderName} in ${channelId}`);

    // Acknowledge immediately — we'll send the actual reply asynchronously
    sendJsonResponse(res, 200, {
      response_type: "ephemeral",
      text: "Processing...",
    });

    // Now handle the command asynchronously (post reply as a message)
    try {
      await handleSlashCommandAsync({
        account,
        cfg,
        runtime,
        client,
        commandText,
        channelId,
        senderId,
        senderName,
        teamId: payload.team_id,
        triggerId: payload.trigger_id,
        kind: auth.kind,
        chatType: auth.chatType,
        channelName: auth.channelName,
        channelDisplay: auth.channelDisplay,
        roomLabel: auth.roomLabel,
        commandAuthorized: auth.commandAuthorized,
        log,
      });
    } catch (err) {
      log?.(`mattermost: slash command handler error: ${String(err)}`);
      try {
        const to = `channel:${channelId}`;
        await sendMessageMattermost(to, "Sorry, something went wrong processing that command.", {
          cfg,
          accountId: account.accountId,
        });
      } catch {
        // best-effort error reply
      }
    }
  };
}

async function handleSlashCommandAsync(params: {
  account: ResolvedMattermostAccount;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  client: ReturnType<typeof createMattermostClient>;
  commandText: string;
  channelId: string;
  senderId: string;
  senderName: string;
  teamId: string;
  kind: "direct" | "group" | "channel";
  chatType: "direct" | "group" | "channel";
  channelName: string;
  channelDisplay: string;
  roomLabel: string;
  commandAuthorized: boolean;
  triggerId?: string;
  log?: (msg: string) => void;
}) {
  const {
    account,
    cfg,
    runtime,
    client,
    commandText,
    channelId,
    senderId,
    senderName,
    teamId,
    kind,
    chatType,
    channelName: _channelName,
    channelDisplay,
    roomLabel,
    commandAuthorized,
    triggerId,
    log,
  } = params;
  const core = getMattermostRuntime();

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "mattermost",
    accountId: account.accountId,
    teamId,
    peer: {
      kind,
      id: kind === "direct" ? senderId : channelId,
    },
  });

  const fromLabel =
    kind === "direct"
      ? `Mattermost DM from ${senderName}`
      : `Mattermost message in ${roomLabel} from ${senderName}`;

  const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
  const pickerEntry = resolveMattermostModelPickerEntry(commandText);
  if (pickerEntry) {
    const data = await buildModelsProviderData(cfg, route.agentId);
    if (data.providers.length === 0) {
      await sendMessageMattermost(to, "No models available.", {
        cfg,
        accountId: account.accountId,
      });
      return;
    }

    const currentModel = resolveMattermostModelPickerCurrentModel({
      cfg,
      route,
      data,
    });
    const view =
      pickerEntry.kind === "summary"
        ? renderMattermostModelSummaryView({
            ownerUserId: senderId,
            currentModel,
          })
        : pickerEntry.kind === "providers"
          ? renderMattermostProviderPickerView({
              ownerUserId: senderId,
              data,
              currentModel,
            })
          : renderMattermostModelsPickerView({
              ownerUserId: senderId,
              data,
              provider: pickerEntry.provider,
              page: 1,
              currentModel,
            });

    await sendMessageMattermost(to, view.text, {
      cfg,
      accountId: account.accountId,
      buttons: view.buttons,
    });
    runtime.log?.(`delivered model picker to ${to}`);
    return;
  }

  // Build inbound context — the command text is the body
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: commandText,
    BodyForAgent: commandText,
    RawBody: commandText,
    CommandBody: commandText,
    From:
      kind === "direct"
        ? `mattermost:${senderId}`
        : kind === "group"
          ? `mattermost:group:${channelId}`
          : `mattermost:channel:${channelId}`,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : undefined,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "mattermost" as const,
    Surface: "mattermost" as const,
    MessageSid: triggerId ?? `slash-${Date.now()}`,
    Timestamp: Date.now(),
    WasMentioned: true,
    CommandAuthorized: commandAuthorized,
    CommandSource: "native" as const,
    OriginatingChannel: "mattermost" as const,
    OriginatingTo: to,
  });

  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "mattermost", account.accountId, {
    fallbackLimit: account.textChunkLimit ?? 4000,
  });
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "mattermost",
    accountId: account.accountId,
  });

  const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "mattermost",
    accountId: account.accountId,
    typing: {
      start: () => sendMattermostTyping(client, { channelId }),
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => log?.(message),
          channel: "mattermost",
          target: channelId,
          error: err,
        });
      },
    },
  });
  const humanDelay = core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      ...replyPipeline,
      humanDelay,
      deliver: async (payload: ReplyPayload) => {
        await deliverMattermostReplyPayload({
          core,
          cfg,
          payload,
          to,
          accountId: account.accountId,
          agentId: route.agentId,
          textLimit,
          tableMode,
          sendMessage: sendMessageMattermost,
        });
        runtime.log?.(`delivered slash reply to ${to}`);
      },
      onError: (err, info) => {
        runtime.error?.(`mattermost slash ${info.kind} reply failed: ${String(err)}`);
      },
      onReplyStart: typingCallbacks?.onReplyStart,
    });

  await core.channel.reply.withReplyDispatcher({
    dispatcher,
    onSettled: () => {
      markDispatchIdle();
    },
    run: () =>
      core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          disableBlockStreaming:
            typeof account.blockStreaming === "boolean" ? !account.blockStreaming : undefined,
          onModelSelected,
        },
      }),
  });
}
