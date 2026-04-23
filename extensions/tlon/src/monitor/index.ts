import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { createLoggerBackedRuntime } from "../../runtime-api.js";
import { getTlonRuntime } from "../runtime.js";
import { createSettingsManager, type TlonSettingsStore } from "../settings.js";
import { normalizeShip, parseChannelNest } from "../targets.js";
import { resolveTlonAccount } from "../types.js";
import { authenticate } from "../urbit/auth.js";
import { ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "../urbit/context.js";
import type { DmInvite, Foreigns } from "../urbit/foreigns.js";
import { sendDm, sendGroupMessage } from "../urbit/send.js";
import { UrbitSSEClient } from "../urbit/sse-client.js";
import { createTlonApprovalRuntime } from "./approval-runtime.js";
import {
  createPendingApproval,
  isAdminCommand,
  isApprovalResponse,
  type PendingApproval,
} from "./approval.js";
import { resolveChannelAuthorization } from "./authorization.js";
import { createTlonCitationResolver } from "./cites.js";
import { fetchAllChannels, fetchInitData } from "./discovery.js";
import { cacheMessage, fetchThreadHistory, getChannelHistory } from "./history.js";
import { downloadMessageImages } from "./media.js";
import {
  createProcessedMessageTracker,
  runWithProcessedMessageClaim,
} from "./processed-messages.js";
import {
  applyTlonSettingsOverrides,
  buildTlonSettingsMigrations,
  mergeUniqueStrings,
  shouldMigrateTlonSetting,
} from "./settings-helpers.js";
import { asRecord, formatErrorMessage, readString } from "./utils.js";
import {
  extractMessageText,
  formatModelName,
  isBotMentioned,
  isDmAllowed,
  isGroupInviteAllowed,
  isSummarizationRequest,
  resolveAuthorizedMessageText,
  stripBotMention,
} from "./utils.js";

export type MonitorTlonOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string | null;
};

function readNumber(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function monitorTlonProvider(opts: MonitorTlonOpts = {}): Promise<void> {
  const core = getTlonRuntime();
  const cfg = core.config.loadConfig();
  if (cfg.channels?.tlon?.enabled === false) {
    return;
  }

  const logger = core.logging.getChildLogger({ module: "tlon-auto-reply" });
  const runtime: RuntimeEnv =
    opts.runtime ??
    createLoggerBackedRuntime({
      logger,
    });

  const account = resolveTlonAccount(cfg, opts.accountId ?? undefined);
  if (!account.enabled) {
    return;
  }
  if (!account.configured || !account.ship || !account.url || !account.code) {
    throw new Error("Tlon account not configured (ship/url/code required)");
  }

  const botShipName = normalizeShip(account.ship);
  runtime.log?.(`[tlon] Starting monitor for ${botShipName}`);

  const ssrfPolicy = ssrfPolicyFromDangerouslyAllowPrivateNetwork(
    account.dangerouslyAllowPrivateNetwork,
  );

  // Store validated values for use in closures (TypeScript narrowing doesn't propagate)
  const accountUrl = account.url;
  const accountCode = account.code;

  // Helper to authenticate with retry logic
  async function authenticateWithRetry(maxAttempts = 10): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      if (opts.abortSignal?.aborted) {
        throw new Error("Aborted while waiting to authenticate");
      }
      try {
        runtime.log?.(`[tlon] Attempting authentication to ${accountUrl}...`);
        return await authenticate(accountUrl, accountCode, { ssrfPolicy });
      } catch (error: unknown) {
        runtime.error?.(
          `[tlon] Failed to authenticate (attempt ${attempt}): ${formatErrorMessage(error)}`,
        );
        if (attempt >= maxAttempts) {
          throw error;
        }
        const delay = Math.min(30000, 1000 * 2 ** (attempt - 1));
        runtime.log?.(`[tlon] Retrying authentication in ${delay}ms...`);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          if (opts.abortSignal) {
            const onAbort = () => {
              clearTimeout(timer);
              reject(new Error("Aborted"));
            };
            opts.abortSignal.addEventListener("abort", onAbort, { once: true });
          }
        });
      }
    }
  }

  let api: UrbitSSEClient | null = null;
  const cookie = await authenticateWithRetry();
  api = new UrbitSSEClient(account.url, cookie, {
    ship: botShipName,
    ssrfPolicy,
    logger: {
      log: (message) => runtime.log?.(message),
      error: (message) => runtime.error?.(message),
    },
    // Re-authenticate on reconnect in case the session expired
    onReconnect: async (client) => {
      runtime.log?.("[tlon] Re-authenticating on SSE reconnect...");
      const newCookie = await authenticateWithRetry(5);
      client.updateCookie(newCookie);
      runtime.log?.("[tlon] Re-authentication successful");
    },
  });

  const processedTracker = createProcessedMessageTracker(2000);
  let groupChannels: string[] = [];
  let botNickname: string | null = null;

  // Settings store manager for hot-reloading config
  const settingsManager = createSettingsManager(api, {
    log: (msg) => runtime.log?.(msg),
    error: (msg) => runtime.error?.(msg),
  });

  // Reactive state that can be updated via settings store
  let effectiveDmAllowlist: string[] = account.dmAllowlist;
  let effectiveShowModelSig: boolean = account.showModelSignature ?? false;
  let effectiveAutoAcceptDmInvites: boolean = account.autoAcceptDmInvites ?? false;
  let effectiveAutoAcceptGroupInvites: boolean = account.autoAcceptGroupInvites ?? false;
  let effectiveGroupInviteAllowlist: string[] = account.groupInviteAllowlist;
  let effectiveAutoDiscoverChannels: boolean = account.autoDiscoverChannels ?? false;
  let effectiveOwnerShip: string | null = account.ownerShip
    ? normalizeShip(account.ownerShip)
    : null;
  let pendingApprovals: PendingApproval[] = [];
  let currentSettings: TlonSettingsStore = {};

  // Track threads we've participated in (by parentId) - respond without mention requirement
  const participatedThreads = new Set<string>();

  // Track DM senders per session to detect shared sessions (security warning)
  const dmSendersBySession = new Map<string, Set<string>>();
  let sharedSessionWarningSent = false;

  // Fetch bot's nickname from contacts
  try {
    const selfProfile = await api.scry("/contacts/v1/self.json");
    if (selfProfile && typeof selfProfile === "object") {
      const profile = selfProfile as { nickname?: { value?: string } };
      botNickname = profile.nickname?.value || null;
      if (botNickname) {
        runtime.log?.(`[tlon] Bot nickname: ${botNickname}`);
      }
    }
  } catch (error: unknown) {
    runtime.log?.(`[tlon] Could not fetch nickname: ${formatErrorMessage(error)}`);
  }

  // Store init foreigns for processing after settings are loaded
  let initForeigns: Foreigns | null = null;

  // Migrate file config to settings store (seed on first run)
  async function migrateConfigToSettings() {
    const migrations = buildTlonSettingsMigrations(account, currentSettings);

    for (const { key, fileValue, settingsValue } of migrations) {
      if (shouldMigrateTlonSetting(fileValue, settingsValue)) {
        try {
          await api!.poke({
            app: "settings",
            mark: "settings-event",
            json: {
              "put-entry": {
                "bucket-key": "tlon",
                "entry-key": key,
                value: fileValue,
                desk: "moltbot",
              },
            },
          });
          runtime.log?.(`[tlon] Migrated ${key} from config to settings store`);
        } catch (err) {
          runtime.log?.(`[tlon] Failed to migrate ${key}: ${String(err)}`);
        }
      }
    }
  }

  // Load settings from settings store (hot-reloadable config)
  try {
    currentSettings = await settingsManager.load();

    // Migrate file config to settings store if not already present
    await migrateConfigToSettings();
    ({
      effectiveDmAllowlist,
      effectiveShowModelSig,
      effectiveAutoAcceptDmInvites,
      effectiveAutoAcceptGroupInvites,
      effectiveGroupInviteAllowlist,
      effectiveAutoDiscoverChannels,
      effectiveOwnerShip,
      pendingApprovals,
      currentSettings,
    } = applyTlonSettingsOverrides({
      account,
      currentSettings,
      log: (message) => runtime.log?.(message),
    }));
  } catch (err) {
    runtime.log?.(`[tlon] Settings store not available, using file config: ${String(err)}`);
  }

  // Run channel discovery AFTER settings are loaded (so settings store value is used)
  if (effectiveAutoDiscoverChannels) {
    try {
      const initData = await fetchInitData(api, runtime);
      if (initData.channels.length > 0) {
        groupChannels = initData.channels;
      }
      initForeigns = initData.foreigns;
    } catch (error: unknown) {
      runtime.error?.(`[tlon] Auto-discovery failed: ${formatErrorMessage(error)}`);
    }
  }

  // Merge manual config with auto-discovered channels
  if (account.groupChannels.length > 0) {
    groupChannels = mergeUniqueStrings(groupChannels, account.groupChannels);
    runtime.log?.(
      `[tlon] Added ${account.groupChannels.length} manual groupChannels to monitoring`,
    );
  }

  // Also merge settings store groupChannels (may have been set via tlon settings command)
  groupChannels = mergeUniqueStrings(groupChannels, currentSettings.groupChannels);

  if (groupChannels.length > 0) {
    runtime.log?.(
      `[tlon] Monitoring ${groupChannels.length} group channel(s): ${groupChannels.join(", ")}`,
    );
  } else {
    runtime.log?.("[tlon] No group channels to monitor (DMs only)");
  }

  // Check if a ship is the owner (always allowed to DM)
  function isOwner(ship: string): boolean {
    if (!effectiveOwnerShip) {
      return false;
    }
    return normalizeShip(ship) === effectiveOwnerShip;
  }

  /**
   * Extract the DM partner ship from the 'whom' field.
   * This is the canonical source for DM routing (more reliable than essay.author).
   * Returns empty string if whom doesn't contain a valid patp-like value.
   */
  function extractDmPartnerShip(whom: unknown): string {
    const raw =
      typeof whom === "string"
        ? whom
        : whom && typeof whom === "object" && "ship" in whom && typeof whom.ship === "string"
          ? whom.ship
          : "";
    const normalized = normalizeShip(raw);
    // Keep DM routing strict: accept only patp-like values.
    return /^~?[a-z-]+$/i.test(normalized) ? normalized : "";
  }

  const processMessage = async (params: {
    messageId: string;
    senderShip: string;
    messageText: string;
    messageContent?: unknown; // Raw Tlon content for media extraction
    isGroup: boolean;
    channelNest?: string;
    hostShip?: string;
    channelName?: string;
    timestamp: number;
    parentId?: string | null;
    isThreadReply?: boolean;
  }) => {
    const {
      messageId,
      senderShip,
      isGroup,
      channelNest,
      hostShip: _hostShip,
      channelName: _channelName,
      timestamp,
      parentId,
      isThreadReply,
      messageContent,
    } = params;
    const groupChannel = channelNest; // For compatibility
    let messageText = params.messageText;

    // Download any images from the message content
    let attachments: Array<{ path: string; contentType: string }> = [];
    if (messageContent) {
      try {
        attachments = await downloadMessageImages(messageContent);
        if (attachments.length > 0) {
          runtime.log?.(`[tlon] Downloaded ${attachments.length} image(s) from message`);
        }
      } catch (error: unknown) {
        runtime.log?.(`[tlon] Failed to download images: ${formatErrorMessage(error)}`);
      }
    }

    // Fetch thread context when entering a thread for the first time
    if (isThreadReply && parentId && groupChannel) {
      try {
        const threadHistory = await fetchThreadHistory(api, groupChannel, parentId, 20, runtime);
        if (threadHistory.length > 0) {
          const threadContext = threadHistory
            .slice(-10) // Last 10 messages for context
            .map((msg) => `${msg.author}: ${msg.content}`)
            .join("\n");

          // Prepend thread context to the message
          // Include note about ongoing conversation for agent judgment
          const contextNote = `[Thread conversation - ${threadHistory.length} previous replies. You are participating in this thread. Only respond if relevant or helpful - you don't need to reply to every message.]`;
          messageText = `${contextNote}\n\n[Previous messages]\n${threadContext}\n\n[Current message]\n${messageText}`;
          runtime?.log?.(
            `[tlon] Added thread context (${threadHistory.length} replies) to message`,
          );
        }
      } catch (error: unknown) {
        runtime?.log?.(`[tlon] Could not fetch thread context: ${formatErrorMessage(error)}`);
        // Continue without thread context - not critical
      }
    }

    if (isGroup && groupChannel && isSummarizationRequest(messageText)) {
      try {
        const history = await getChannelHistory(api, groupChannel, 50, runtime);
        if (history.length === 0) {
          const noHistoryMsg =
            "I couldn't fetch any messages for this channel. It might be empty or there might be a permissions issue.";
          if (isGroup) {
            const parsed = parseChannelNest(groupChannel);
            if (parsed) {
              await sendGroupMessage({
                api: api,
                fromShip: botShipName,
                hostShip: parsed.hostShip,
                channelName: parsed.channelName,
                text: noHistoryMsg,
              });
            }
          } else {
            await sendDm({
              api: api,
              fromShip: botShipName,
              toShip: senderShip,
              text: noHistoryMsg,
            });
          }
          return;
        }

        const historyText = history
          .map(
            (msg) => `[${new Date(msg.timestamp).toLocaleString()}] ${msg.author}: ${msg.content}`,
          )
          .join("\n");

        messageText =
          `Please summarize this channel conversation (${history.length} recent messages):\n\n${historyText}\n\n` +
          "Provide a concise summary highlighting:\n" +
          "1. Main topics discussed\n" +
          "2. Key decisions or conclusions\n" +
          "3. Action items if any\n" +
          "4. Notable participants";
      } catch (error: unknown) {
        const errorMsg = `Sorry, I encountered an error while fetching the channel history: ${formatErrorMessage(error)}`;
        if (isGroup && groupChannel) {
          const parsed = parseChannelNest(groupChannel);
          if (parsed) {
            await sendGroupMessage({
              api: api,
              fromShip: botShipName,
              hostShip: parsed.hostShip,
              channelName: parsed.channelName,
              text: errorMsg,
            });
          }
        } else {
          await sendDm({ api: api, fromShip: botShipName, toShip: senderShip, text: errorMsg });
        }
        return;
      }
    }

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "tlon",
      accountId: opts.accountId ?? undefined,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? (groupChannel ?? senderShip) : senderShip,
      },
    });

    // Warn if multiple users share a DM session (insecure dmScope configuration)
    if (!isGroup) {
      const sessionKey = route.sessionKey;
      if (!dmSendersBySession.has(sessionKey)) {
        dmSendersBySession.set(sessionKey, new Set());
      }
      const senders = dmSendersBySession.get(sessionKey)!;
      if (senders.size > 0 && !senders.has(senderShip)) {
        // Log warning
        runtime.log?.(
          `[tlon] ⚠️ SECURITY: Multiple users sharing DM session. ` +
            `Configure "session.dmScope: per-channel-peer" in OpenClaw config.`,
        );

        // Notify owner via DM (once per monitor session)
        if (!sharedSessionWarningSent && effectiveOwnerShip) {
          sharedSessionWarningSent = true;
          const warningMsg =
            `⚠️ Security Warning: Multiple users are sharing a DM session with this bot. ` +
            `This can leak conversation context between users.\n\n` +
            `Fix: Add to your OpenClaw config:\n` +
            `session:\n  dmScope: "per-channel-peer"\n\n` +
            `Docs: https://docs.openclaw.ai/concepts/session#secure-dm-mode`;

          // Send async, don't block message processing
          sendDm({
            api,
            fromShip: botShipName,
            toShip: effectiveOwnerShip,
            text: warningMsg,
          }).catch((err) =>
            runtime.error?.(`[tlon] Failed to send security warning to owner: ${err}`),
          );
        }
      }
      senders.add(senderShip);
    }

    const senderRole = isOwner(senderShip) ? "owner" : "user";
    const fromLabel = isGroup
      ? `${senderShip} [${senderRole}] in ${channelNest}`
      : `${senderShip} [${senderRole}]`;

    // Compute command authorization for slash commands (owner-only)
    const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(
      messageText,
      cfg,
    );
    let commandAuthorized = false;

    if (shouldComputeAuth) {
      const useAccessGroups = cfg.commands?.useAccessGroups !== false;
      const senderIsOwner = isOwner(senderShip);

      commandAuthorized = core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [{ configured: Boolean(effectiveOwnerShip), allowed: senderIsOwner }],
      });

      // Log when non-owner attempts a slash command (will be silently ignored by Gateway)
      if (!commandAuthorized) {
        console.log(
          `[tlon] Command attempt denied: ${senderShip} is not owner (owner=${effectiveOwnerShip ?? "not configured"})`,
        );
      }
    }

    // Prepend attachment annotations to message body (similar to Signal format)
    let bodyWithAttachments = messageText;
    if (attachments.length > 0) {
      const mediaLines = attachments
        .map((a) => `[media attached: ${a.path} (${a.contentType}) | ${a.path}]`)
        .join("\n");
      bodyWithAttachments = mediaLines + "\n" + messageText;
    }

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Tlon",
      from: fromLabel,
      timestamp,
      body: bodyWithAttachments,
    });

    // Strip bot ship mention for CommandBody so "/status" is recognized as command-only
    const commandBody = isGroup ? stripBotMention(messageText, botShipName) : messageText;

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: messageText,
      CommandBody: commandBody,
      From: isGroup ? `tlon:group:${groupChannel}` : `tlon:${senderShip}`,
      To: `tlon:${botShipName}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      SenderName: senderShip,
      SenderId: senderShip,
      SenderRole: senderRole,
      CommandAuthorized: commandAuthorized,
      CommandSource: "text" as const,
      Provider: "tlon",
      Surface: "tlon",
      MessageSid: messageId,
      // Include downloaded media attachments
      ...(attachments.length > 0 && { Attachments: attachments }),
      OriginatingChannel: "tlon",
      OriginatingTo: `tlon:${isGroup ? groupChannel : botShipName}`,
      // Include thread context for automatic reply routing
      ...(parentId && { ThreadId: parentId, ReplyToId: parentId }),
    });

    const dispatchStartTime = Date.now();

    const responsePrefix = core.channel.reply.resolveEffectiveMessagesConfig(
      cfg,
      route.agentId,
    ).responsePrefix;
    const humanDelay = core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);

    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        responsePrefix,
        humanDelay,
        deliver: async (payload: ReplyPayload) => {
          let replyText = payload.text;
          if (!replyText) {
            return;
          }

          // Use settings store value if set, otherwise fall back to file config
          const showSignature = effectiveShowModelSig;
          if (showSignature) {
            const extPayload = payload as {
              metadata?: { model?: string };
              model?: string;
            };
            const defaultModel = cfg.agents?.defaults?.model;
            const modelInfo =
              extPayload.metadata?.model ||
              extPayload.model ||
              (typeof defaultModel === "string" ? defaultModel : defaultModel?.primary);
            replyText = `${replyText}\n\n_[Generated by ${formatModelName(modelInfo)}]_`;
          }

          if (isGroup && groupChannel) {
            const parsed = parseChannelNest(groupChannel);
            if (!parsed) {
              return;
            }
            await sendGroupMessage({
              api: api,
              fromShip: botShipName,
              hostShip: parsed.hostShip,
              channelName: parsed.channelName,
              text: replyText,
              replyToId: parentId ?? undefined,
            });
            // Track thread participation for future replies without mention
            if (parentId) {
              participatedThreads.add(parentId);
              runtime.log?.(`[tlon] Now tracking thread for future replies: ${parentId}`);
            }
          } else {
            await sendDm({ api: api, fromShip: botShipName, toShip: senderShip, text: replyText });
          }
        },
        onError: (err, info) => {
          const dispatchDuration = Date.now() - dispatchStartTime;
          runtime.error?.(
            `[tlon] ${info.kind} reply failed after ${dispatchDuration}ms: ${String(err)}`,
          );
        },
      },
    });
  };

  // Track which channels we're interested in for filtering firehose events
  const watchedChannels = new Set<string>(groupChannels);
  const _watchedDMs = new Set<string>();

  const refreshWatchedChannels = async (): Promise<number> => {
    const discoveredChannels = await fetchAllChannels(api, runtime);
    let newCount = 0;
    for (const channelNest of discoveredChannels) {
      if (!watchedChannels.has(channelNest)) {
        watchedChannels.add(channelNest);
        newCount++;
      }
    }
    return newCount;
  };

  const { resolveAllCites } = createTlonCitationResolver({
    api: { scry: (path) => api.scry(path) },
    runtime,
  });

  const { queueApprovalRequest, handleApprovalResponse, handleAdminCommand } =
    createTlonApprovalRuntime({
      api: {
        poke: (payload) => api.poke(payload),
        scry: (path) => api.scry(path),
      },
      runtime,
      botShipName,
      getPendingApprovals: () => pendingApprovals,
      setPendingApprovals: (approvals) => {
        pendingApprovals = approvals;
      },
      getCurrentSettings: () => currentSettings,
      setCurrentSettings: (settings) => {
        currentSettings = settings;
      },
      getEffectiveDmAllowlist: () => effectiveDmAllowlist,
      setEffectiveDmAllowlist: (ships) => {
        effectiveDmAllowlist = ships;
      },
      getEffectiveOwnerShip: () => effectiveOwnerShip,
      processApprovedMessage: async (approval) => {
        if (!approval.originalMessage) {
          return;
        }
        if (approval.type === "dm") {
          await processMessage({
            messageId: approval.originalMessage.messageId,
            senderShip: approval.requestingShip,
            messageText: approval.originalMessage.messageText,
            messageContent: approval.originalMessage.messageContent,
            isGroup: false,
            timestamp: approval.originalMessage.timestamp,
          });
          return;
        }
        if (approval.type === "channel" && approval.channelNest) {
          const parsedChannel = parseChannelNest(approval.channelNest);
          await processMessage({
            messageId: approval.originalMessage.messageId,
            senderShip: approval.requestingShip,
            messageText: approval.originalMessage.messageText,
            messageContent: approval.originalMessage.messageContent,
            isGroup: true,
            channelNest: approval.channelNest,
            hostShip: parsedChannel?.hostShip,
            channelName: parsedChannel?.channelName,
            timestamp: approval.originalMessage.timestamp,
            parentId: approval.originalMessage.parentId,
            isThreadReply: approval.originalMessage.isThreadReply,
          });
        }
      },
      refreshWatchedChannels,
    });

  // Firehose handler for all channel messages (/v2)
  const handleChannelsFirehose = async (event: unknown) => {
    try {
      const eventRecord = asRecord(event);
      const nest = readString(eventRecord, "nest");
      if (!nest) {
        return;
      }

      // Only process channels we're watching
      if (!watchedChannels.has(nest)) {
        return;
      }

      const response = asRecord(eventRecord?.response);
      if (!response) {
        return;
      }

      // Handle post responses (new posts and replies)
      const post = asRecord(response.post);
      const rPost = asRecord(post?.["r-post"]);
      const set = asRecord(rPost?.set);
      const reply = asRecord(rPost?.reply);
      const replyPayload = asRecord(reply?.["r-reply"]);
      const replySet = asRecord(replyPayload?.set);
      const essay = asRecord(set?.essay);
      const memo = asRecord(replySet?.memo);
      if (!essay && !memo) {
        return;
      }

      const content = memo ?? essay;
      if (!content) {
        return;
      }
      const isThreadReply = Boolean(memo);
      const messageId = isThreadReply ? readString(reply, "id") : readString(post, "id");
      if (!messageId) {
        return;
      }

      const processed = await runWithProcessedMessageClaim({
        tracker: processedTracker,
        id: messageId,
        task: async () => {
          const senderShip = normalizeShip(readString(content, "author") ?? "");
          if (!senderShip || senderShip === botShipName) {
            return;
          }

          const rawText = extractMessageText(content.content);
          if (!rawText.trim()) {
            return;
          }

          const contentBody = content.content;
          const sentAt = readNumber(content, "sent") ?? Date.now();

          cacheMessage(nest, {
            author: senderShip,
            content: rawText,
            timestamp: sentAt,
            id: messageId,
          });

          // Get thread info early for participation check
          const seal = isThreadReply ? asRecord(replySet?.seal) : asRecord(set?.seal);
          const parentId = readString(seal, "parent-id") ?? readString(seal, "parent") ?? null;

          // Check if we should respond:
          // 1. Direct mention always triggers response
          // 2. Thread replies where we've participated - respond if relevant (let agent decide)
          const mentioned = isBotMentioned(rawText, botShipName, botNickname ?? undefined);
          const inParticipatedThread =
            isThreadReply && parentId && participatedThreads.has(parentId);

          if (!mentioned && !inParticipatedThread) {
            return;
          }

          // Log why we're responding
          if (inParticipatedThread && !mentioned) {
            runtime.log?.(
              `[tlon] Responding to thread we participated in (no mention): ${parentId}`,
            );
          }

          // Owner is always allowed
          if (isOwner(senderShip)) {
            runtime.log?.(`[tlon] Owner ${senderShip} is always allowed in channels`);
          } else {
            const { mode, allowedShips } = resolveChannelAuthorization(cfg, nest, currentSettings);
            if (mode === "restricted") {
              const normalizedAllowed = allowedShips.map(normalizeShip);
              if (!normalizedAllowed.includes(senderShip)) {
                // If owner is configured, queue approval request
                if (effectiveOwnerShip) {
                  const approval = createPendingApproval({
                    type: "channel",
                    requestingShip: senderShip,
                    channelNest: nest,
                    messagePreview: rawText.slice(0, 100),
                    originalMessage: {
                      messageId: messageId ?? "",
                      messageText: rawText,
                      messageContent: contentBody,
                      timestamp: sentAt,
                      parentId: parentId ?? undefined,
                      isThreadReply,
                    },
                  });
                  await queueApprovalRequest(approval);
                } else {
                  runtime.log?.(
                    `[tlon] Access denied: ${senderShip} in ${nest} (allowed: ${allowedShips.join(", ")})`,
                  );
                }
                return;
              }
            }
          }

          const messageText = await resolveAuthorizedMessageText({
            rawText,
            content: contentBody,
            authorizedForCites: true,
            resolveAllCites,
          });

          const parsed = parseChannelNest(nest);
          await processMessage({
            messageId: messageId ?? "",
            senderShip,
            messageText,
            messageContent: contentBody, // Pass raw content for media extraction
            isGroup: true,
            channelNest: nest,
            hostShip: parsed?.hostShip,
            channelName: parsed?.channelName,
            timestamp: sentAt,
            parentId,
            isThreadReply,
          });
        },
      });
      if (processed.kind === "duplicate") {
        return;
      }
    } catch (error: unknown) {
      runtime.error?.(`[tlon] Error handling channel firehose event: ${formatErrorMessage(error)}`);
    }
  };

  // Firehose handler for all DM messages (/v3)
  // Track which DM invites we've already processed to avoid duplicate accepts
  const processedDmInvites = new Set<string>();

  const handleChatFirehose = async (event: unknown) => {
    try {
      // Handle DM invite lists (arrays)
      if (Array.isArray(event)) {
        for (const invite of event as DmInvite[]) {
          const ship = normalizeShip(invite.ship || "");
          if (!ship || processedDmInvites.has(ship)) {
            continue;
          }

          // Owner is always allowed
          if (isOwner(ship)) {
            try {
              await api.poke({
                app: "chat",
                mark: "chat-dm-rsvp",
                json: { ship, ok: true },
              });
              processedDmInvites.add(ship);
              runtime.log?.(`[tlon] Auto-accepted DM invite from owner ${ship}`);
            } catch (err) {
              runtime.error?.(`[tlon] Failed to auto-accept DM from owner: ${String(err)}`);
            }
            continue;
          }

          // Auto-accept if on allowlist and auto-accept is enabled
          if (effectiveAutoAcceptDmInvites && isDmAllowed(ship, effectiveDmAllowlist)) {
            try {
              await api.poke({
                app: "chat",
                mark: "chat-dm-rsvp",
                json: { ship, ok: true },
              });
              processedDmInvites.add(ship);
              runtime.log?.(`[tlon] Auto-accepted DM invite from ${ship}`);
            } catch (err) {
              runtime.error?.(`[tlon] Failed to auto-accept DM from ${ship}: ${String(err)}`);
            }
            continue;
          }

          // If owner is configured and ship is not on allowlist, queue approval
          if (effectiveOwnerShip && !isDmAllowed(ship, effectiveDmAllowlist)) {
            const approval = createPendingApproval({
              type: "dm",
              requestingShip: ship,
              messagePreview: "(DM invite - no message yet)",
            });
            await queueApprovalRequest(approval);
            processedDmInvites.add(ship); // Mark as processed to avoid duplicate notifications
          }
        }
        return;
      }
      const eventRecord = asRecord(event);
      if (!eventRecord) {
        return;
      }

      const whom = eventRecord.whom; // DM partner ship or club ID
      const messageId = readString(eventRecord, "id");
      const response = asRecord(eventRecord.response);
      if (!messageId || !response) {
        return;
      }

      // Handle add events (new messages)
      const essay = asRecord(asRecord(response.add)?.essay);
      if (!essay) {
        return;
      }

      const processed = await runWithProcessedMessageClaim({
        tracker: processedTracker,
        id: messageId,
        task: async () => {
          const authorShip = normalizeShip(readString(essay, "author") ?? "");
          const partnerShip = extractDmPartnerShip(whom);
          const senderShip = partnerShip || authorShip;

          // Ignore the bot's own outbound DM events.
          if (authorShip === botShipName) {
            return;
          }
          if (!senderShip || senderShip === botShipName) {
            return;
          }

          // Log mismatch between author and partner for debugging
          if (authorShip && partnerShip && authorShip !== partnerShip) {
            runtime.log?.(
              `[tlon] DM ship mismatch (author=${authorShip}, partner=${partnerShip}) - routing to partner`,
            );
          }

          const rawText = extractMessageText(essay.content);
          if (!rawText.trim()) {
            return;
          }

          // Check if this is the owner sending an approval response
          const messageText = rawText;
          if (isOwner(senderShip) && isApprovalResponse(messageText)) {
            const handled = await handleApprovalResponse(messageText);
            if (handled) {
              runtime.log?.(`[tlon] Processed approval response from owner: ${messageText}`);
              return;
            }
          }

          // Check if this is the owner sending an admin command
          if (isOwner(senderShip) && isAdminCommand(messageText)) {
            const handled = await handleAdminCommand(messageText);
            if (handled) {
              runtime.log?.(`[tlon] Processed admin command from owner: ${messageText}`);
              return;
            }
          }

          // Owner is always allowed to DM (bypass allowlist)
          if (isOwner(senderShip)) {
            const resolvedMessageText = await resolveAuthorizedMessageText({
              rawText,
              content: essay.content,
              authorizedForCites: true,
              resolveAllCites,
            });
            runtime.log?.(`[tlon] Processing DM from owner ${senderShip}`);
            await processMessage({
              messageId: messageId ?? "",
              senderShip,
              messageText: resolvedMessageText,
              messageContent: essay.content,
              isGroup: false,
              timestamp: readNumber(essay, "sent") ?? Date.now(),
            });
            return;
          }

          // For DMs from others, check allowlist
          if (!isDmAllowed(senderShip, effectiveDmAllowlist)) {
            // If owner is configured, queue approval request
            if (effectiveOwnerShip) {
              const approval = createPendingApproval({
                type: "dm",
                requestingShip: senderShip,
                messagePreview: messageText.slice(0, 100),
                originalMessage: {
                  messageId: messageId ?? "",
                  messageText,
                  messageContent: essay.content,
                  timestamp: readNumber(essay, "sent") ?? Date.now(),
                },
              });
              await queueApprovalRequest(approval);
            } else {
              runtime.log?.(`[tlon] Blocked DM from ${senderShip}: not in allowlist`);
            }
            return;
          }

          await processMessage({
            messageText: await resolveAuthorizedMessageText({
              rawText,
              content: essay.content,
              authorizedForCites: true,
              resolveAllCites,
            }),
            messageId: messageId ?? "",
            senderShip,
            messageContent: essay.content, // Pass raw content for media extraction
            isGroup: false,
            timestamp: readNumber(essay, "sent") ?? Date.now(),
          });
        },
      });
      if (processed.kind === "duplicate") {
        return;
      }
    } catch (error: unknown) {
      runtime.error?.(`[tlon] Error handling chat firehose event: ${formatErrorMessage(error)}`);
    }
  };

  try {
    runtime.log?.("[tlon] Subscribing to firehose updates...");

    // Subscribe to channels firehose (/v2)
    await api.subscribe({
      app: "channels",
      path: "/v2",
      event: handleChannelsFirehose,
      err: (error) => {
        runtime.error?.(`[tlon] Channels firehose error: ${String(error)}`);
      },
      quit: () => {
        runtime.log?.("[tlon] Channels firehose subscription ended");
      },
    });
    runtime.log?.("[tlon] Subscribed to channels firehose (/v2)");

    // Subscribe to chat/DM firehose (/v3)
    await api.subscribe({
      app: "chat",
      path: "/v3",
      event: handleChatFirehose,
      err: (error) => {
        runtime.error?.(`[tlon] Chat firehose error: ${String(error)}`);
      },
      quit: () => {
        runtime.log?.("[tlon] Chat firehose subscription ended");
      },
    });
    runtime.log?.("[tlon] Subscribed to chat firehose (/v3)");

    // Subscribe to contacts updates to track nickname changes
    await api.subscribe({
      app: "contacts",
      path: "/v1/news",
      event: (event: unknown) => {
        try {
          const eventRecord = asRecord(event);
          // Look for self profile updates
          if (eventRecord?.self) {
            const selfUpdate = asRecord(eventRecord.self);
            const contact = asRecord(selfUpdate?.contact);
            const nickname = asRecord(contact?.nickname);
            if (nickname && "value" in nickname) {
              const newNickname = readString(nickname, "value") ?? null;
              if (newNickname !== botNickname) {
                botNickname = newNickname;
                runtime.log?.(`[tlon] Nickname updated: ${botNickname}`);
              }
            }
          }
        } catch (error: unknown) {
          runtime.error?.(`[tlon] Error handling contacts event: ${formatErrorMessage(error)}`);
        }
      },
      err: (error) => {
        runtime.error?.(`[tlon] Contacts subscription error: ${String(error)}`);
      },
      quit: () => {
        runtime.log?.("[tlon] Contacts subscription ended");
      },
    });
    runtime.log?.("[tlon] Subscribed to contacts updates (/v1/news)");

    // Subscribe to settings store for hot-reloading config
    settingsManager.onChange((newSettings) => {
      currentSettings = newSettings;

      // Update watched channels if settings changed
      if (newSettings.groupChannels?.length) {
        const newChannels = newSettings.groupChannels;
        for (const ch of newChannels) {
          if (!watchedChannels.has(ch)) {
            watchedChannels.add(ch);
            runtime.log?.(`[tlon] Settings: now watching channel ${ch}`);
          }
        }
        // Note: we don't remove channels from watchedChannels to avoid missing messages
        // during transitions. The authorization check handles access control.
      }

      // Recompute effective settings from the latest snapshot so deletions
      // cleanly fall back to file config and empty arrays remain authoritative.
      ({
        effectiveDmAllowlist,
        effectiveShowModelSig,
        effectiveAutoAcceptDmInvites,
        effectiveAutoAcceptGroupInvites,
        effectiveGroupInviteAllowlist,
        effectiveAutoDiscoverChannels,
        effectiveOwnerShip,
        pendingApprovals,
      } = applyTlonSettingsOverrides({
        account,
        currentSettings: newSettings,
        log: (message) => runtime.log?.(message),
      }));
    });

    try {
      await settingsManager.startSubscription();
    } catch (err) {
      // Settings subscription is optional - don't fail if it doesn't work
      runtime.log?.(`[tlon] Settings subscription not available: ${String(err)}`);
    }

    // Subscribe to groups-ui for real-time channel additions (when invites are accepted)
    try {
      await api.subscribe({
        app: "groups",
        path: "/groups/ui",
        event: async (event: unknown) => {
          try {
            const eventRecord = asRecord(event);
            // Handle group/channel join events
            // Event structure: { group: { flag: "~host/group-name", ... }, channels: { ... } }
            if (eventRecord) {
              // Check for new channels being added to groups
              const channels = asRecord(eventRecord.channels);
              if (channels) {
                for (const [channelNest, _channelData] of Object.entries(channels)) {
                  // Only monitor chat channels
                  if (!channelNest.startsWith("chat/")) {
                    continue;
                  }

                  // If this is a new channel we're not watching yet, add it
                  if (!watchedChannels.has(channelNest)) {
                    watchedChannels.add(channelNest);
                    runtime.log?.(
                      `[tlon] Auto-detected new channel (invite accepted): ${channelNest}`,
                    );

                    // Persist to settings store so it survives restarts
                    if (effectiveAutoAcceptGroupInvites) {
                      try {
                        const currentChannels = currentSettings.groupChannels || [];
                        if (!currentChannels.includes(channelNest)) {
                          const updatedChannels = [...currentChannels, channelNest];
                          // Poke settings store to persist
                          await api.poke({
                            app: "settings",
                            mark: "settings-event",
                            json: {
                              "put-entry": {
                                "bucket-key": "tlon",
                                "entry-key": "groupChannels",
                                value: updatedChannels,
                                desk: "moltbot",
                              },
                            },
                          });
                          runtime.log?.(`[tlon] Persisted ${channelNest} to settings store`);
                        }
                      } catch (err) {
                        runtime.error?.(
                          `[tlon] Failed to persist channel to settings: ${String(err)}`,
                        );
                      }
                    }
                  }
                }
              }

              // Also check for the "join" event structure
              const join = asRecord(eventRecord.join);
              if (join) {
                const joinChannels = Array.isArray(join.channels) ? join.channels : [];
                if (joinChannels.length > 0) {
                  for (const channelNest of joinChannels) {
                    if (typeof channelNest !== "string") {
                      continue;
                    }
                    if (!channelNest.startsWith("chat/")) {
                      continue;
                    }
                    if (!watchedChannels.has(channelNest)) {
                      watchedChannels.add(channelNest);
                      runtime.log?.(`[tlon] Auto-detected joined channel: ${channelNest}`);

                      // Persist to settings store
                      if (effectiveAutoAcceptGroupInvites) {
                        try {
                          const currentChannels = currentSettings.groupChannels || [];
                          if (!currentChannels.includes(channelNest)) {
                            const updatedChannels = [...currentChannels, channelNest];
                            await api.poke({
                              app: "settings",
                              mark: "settings-event",
                              json: {
                                "put-entry": {
                                  "bucket-key": "tlon",
                                  "entry-key": "groupChannels",
                                  value: updatedChannels,
                                  desk: "moltbot",
                                },
                              },
                            });
                            runtime.log?.(`[tlon] Persisted ${channelNest} to settings store`);
                          }
                        } catch (err) {
                          runtime.error?.(
                            `[tlon] Failed to persist channel to settings: ${String(err)}`,
                          );
                        }
                      }
                    }
                  }
                }
              }
            }
          } catch (error: unknown) {
            runtime.error?.(`[tlon] Error handling groups-ui event: ${formatErrorMessage(error)}`);
          }
        },
        err: (error) => {
          runtime.error?.(`[tlon] Groups-ui subscription error: ${String(error)}`);
        },
        quit: () => {
          runtime.log?.("[tlon] Groups-ui subscription ended");
        },
      });
      runtime.log?.("[tlon] Subscribed to groups-ui for real-time channel detection");
    } catch (err) {
      // Groups-ui subscription is optional - channel discovery will still work via polling
      runtime.log?.(`[tlon] Groups-ui subscription failed (will rely on polling): ${String(err)}`);
    }

    // Subscribe to foreigns for auto-accepting group invites
    // Always subscribe so we can hot-reload the setting via settings store
    {
      const processedGroupInvites = new Set<string>();

      // Helper to process pending invites
      const processPendingInvites = async (foreigns: Foreigns) => {
        if (!foreigns || typeof foreigns !== "object") {
          return;
        }

        for (const [groupFlag, foreign] of Object.entries(foreigns)) {
          if (processedGroupInvites.has(groupFlag)) {
            continue;
          }
          if (!foreign.invites || foreign.invites.length === 0) {
            continue;
          }

          const validInvite = foreign.invites.find((inv) => inv.valid);
          if (!validInvite) {
            continue;
          }

          const inviterShip = validInvite.from;
          // Owner invites are always accepted
          if (isOwner(inviterShip)) {
            try {
              await api.poke({
                app: "groups",
                mark: "group-join",
                json: {
                  flag: groupFlag,
                  "join-all": true,
                },
              });
              processedGroupInvites.add(groupFlag);
              runtime.log?.(`[tlon] Auto-accepted group invite from owner: ${groupFlag}`);
            } catch (err) {
              runtime.error?.(`[tlon] Failed to accept group invite from owner: ${String(err)}`);
            }
            continue;
          }

          // Skip if auto-accept is disabled
          if (!effectiveAutoAcceptGroupInvites) {
            // If owner is configured, queue approval
            if (effectiveOwnerShip) {
              const approval = createPendingApproval({
                type: "group",
                requestingShip: inviterShip,
                groupFlag,
              });
              await queueApprovalRequest(approval);
              processedGroupInvites.add(groupFlag);
            }
            continue;
          }

          // Check if inviter is on allowlist
          const isAllowed = isGroupInviteAllowed(inviterShip, effectiveGroupInviteAllowlist);

          if (!isAllowed) {
            // If owner is configured, queue approval
            if (effectiveOwnerShip) {
              const approval = createPendingApproval({
                type: "group",
                requestingShip: inviterShip,
                groupFlag,
              });
              await queueApprovalRequest(approval);
              processedGroupInvites.add(groupFlag);
            } else {
              runtime.log?.(
                `[tlon] Rejected group invite from ${inviterShip} (not in groupInviteAllowlist): ${groupFlag}`,
              );
              processedGroupInvites.add(groupFlag);
            }
            continue;
          }

          // Inviter is on allowlist - accept the invite
          try {
            await api.poke({
              app: "groups",
              mark: "group-join",
              json: {
                flag: groupFlag,
                "join-all": true,
              },
            });
            processedGroupInvites.add(groupFlag);
            runtime.log?.(
              `[tlon] Auto-accepted group invite: ${groupFlag} (from ${validInvite.from})`,
            );
          } catch (err) {
            runtime.error?.(`[tlon] Failed to auto-accept group ${groupFlag}: ${String(err)}`);
          }
        }
      };

      // Process existing pending invites from init data
      if (initForeigns) {
        await processPendingInvites(initForeigns);
      }

      try {
        await api.subscribe({
          app: "groups",
          path: "/v1/foreigns",
          event: (data: unknown) => {
            void (async () => {
              try {
                await processPendingInvites(data as Foreigns);
              } catch (error: unknown) {
                runtime.error?.(
                  `[tlon] Error handling foreigns event: ${formatErrorMessage(error)}`,
                );
              }
            })();
          },
          err: (error) => {
            runtime.error?.(`[tlon] Foreigns subscription error: ${String(error)}`);
          },
          quit: () => {
            runtime.log?.("[tlon] Foreigns subscription ended");
          },
        });
        runtime.log?.(
          "[tlon] Subscribed to foreigns (/v1/foreigns) for auto-accepting group invites",
        );
      } catch (err) {
        runtime.log?.(`[tlon] Foreigns subscription failed: ${String(err)}`);
      }
    }

    // Discover channels to watch
    if (effectiveAutoDiscoverChannels) {
      const discoveredChannels = await fetchAllChannels(api, runtime);
      for (const channelNest of discoveredChannels) {
        watchedChannels.add(channelNest);
      }
      runtime.log?.(`[tlon] Watching ${watchedChannels.size} channel(s)`);
    }

    // Log watched channels
    for (const channelNest of watchedChannels) {
      runtime.log?.(`[tlon] Watching channel: ${channelNest}`);
    }

    runtime.log?.("[tlon] All subscriptions registered, connecting to SSE stream...");
    await api.connect();
    runtime.log?.("[tlon] Connected! Firehose subscriptions active");

    // Periodically refresh channel discovery
    const pollInterval = setInterval(
      async () => {
        if (!opts.abortSignal?.aborted) {
          try {
            if (effectiveAutoDiscoverChannels) {
              const discoveredChannels = await fetchAllChannels(api, runtime);
              for (const channelNest of discoveredChannels) {
                if (!watchedChannels.has(channelNest)) {
                  watchedChannels.add(channelNest);
                  runtime.log?.(`[tlon] Now watching new channel: ${channelNest}`);
                }
              }
            }
          } catch (error: unknown) {
            runtime.error?.(`[tlon] Channel refresh error: ${formatErrorMessage(error)}`);
          }
        }
      },
      2 * 60 * 1000,
    );

    if (opts.abortSignal) {
      const signal = opts.abortSignal;
      await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            clearInterval(pollInterval);
            resolve(null);
          },
          { once: true },
        );
      });
    } else {
      await new Promise(() => {});
    }
  } finally {
    try {
      await api?.close();
    } catch (error: unknown) {
      runtime.error?.(`[tlon] Cleanup error: ${formatErrorMessage(error)}`);
    }
  }
}
