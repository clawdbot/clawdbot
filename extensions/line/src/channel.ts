import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  LineConfigSchema,
  processLineMessage,
  type ChannelPlugin,
  type MoltbotConfig,
  type LineConfig,
  type LineChannelData,
  type ResolvedLineAccount,
} from "clawdbot/plugin-sdk";

import { getLineRuntime } from "./runtime.js";

// LINE channel metadata
const meta = {
  id: "line",
  label: "LINE",
  selectionLabel: "LINE (Messaging API)",
  detailLabel: "LINE Bot",
  docsPath: "/channels/line",
  docsLabel: "line",
  blurb: "LINE Messaging API bot for Japan/Taiwan/Thailand markets.",
  systemImage: "message.fill",
};

function parseThreadId(threadId?: string | number | null): number | undefined {
  if (threadId == null) return undefined;
  if (typeof threadId === "number") {
    return Number.isFinite(threadId) ? Math.trunc(threadId) : undefined;
  }
  const trimmed = threadId.trim();
  if (!trimmed) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export const linePlugin: ChannelPlugin<ResolvedLineAccount> = {
  id: "line",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  pairing: {
    idLabel: "lineUserId",
    normalizeAllowEntry: (entry) => {
      // LINE IDs are case-sensitive; only strip prefix variants (line: / line:user:).
      return entry.replace(/^line:(?:user:)?/i, "");
    },
    notifyApproval: async ({ cfg, id }) => {
      const line = getLineRuntime().channel.line;
      const account = line.resolveLineAccount({ cfg });
      if (!account.channelAccessToken) {
        throw new Error("LINE channel access token not configured");
      }
      await line.pushMessageLine(id, "Moltbot: your access has been approved.", {
        channelAccessToken: account.channelAccessToken,
      });
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.line"] },
  configSchema: buildChannelConfigSchema(LineConfigSchema),
  config: {
    listAccountIds: (cfg) => getLineRuntime().channel.line.listLineAccountIds(cfg),
    resolveAccount: (cfg, accountId) =>
      getLineRuntime().channel.line.resolveLineAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => getLineRuntime().channel.line.resolveDefaultLineAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const lineConfig = (cfg.channels?.line ?? {}) as LineConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            line: {
              ...lineConfig,
              enabled,
            },
          },
        };
      }
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          line: {
            ...lineConfig,
            accounts: {
              ...lineConfig.accounts,
              [accountId]: {
                ...lineConfig.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const lineConfig = (cfg.channels?.line ?? {}) as LineConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        const { channelAccessToken, channelSecret, tokenFile, secretFile, ...rest } = lineConfig;
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            line: rest,
          },
        };
      }
      const accounts = { ...lineConfig.accounts };
      delete accounts[accountId];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          line: {
            ...lineConfig,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },
    isConfigured: (account) => Boolean(account.channelAccessToken?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.channelAccessToken?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (getLineRuntime().channel.line.resolveLineAccount({ cfg, accountId }).config.allowFrom ?? []).map(
        (entry) => String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => {
          // LINE sender IDs are case-sensitive; keep original casing.
          return entry.replace(/^line:(?:user:)?/i, "");
        }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(
        (cfg.channels?.line as LineConfig | undefined)?.accounts?.[resolvedAccountId],
      );
      const basePath = useAccountPath
        ? `channels.line.accounts.${resolvedAccountId}.`
        : "channels.line.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: "moltbot pairing approve line <code>",
        normalizeEntry: (raw) => raw.replace(/^line:(?:user:)?/i, ""),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy =
        (cfg.channels?.defaults as { groupPolicy?: string } | undefined)?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- LINE groups: groupPolicy="open" allows any member in groups to trigger. Set channels.line.groupPolicy="allowlist" + channels.line.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      const account = getLineRuntime().channel.line.resolveLineAccount({ cfg, accountId });
      const groups = account.config.groups;
      if (!groups) return false;
      const groupConfig = groups[groupId] ?? groups["*"];
      return groupConfig?.requireMention ?? false;
    },
  },
  messaging: {
    normalizeTarget: (target) => {
      const trimmed = target.trim();
      if (!trimmed) return null;
      return trimmed.replace(/^line:(group|room|user):/i, "").replace(/^line:/i, "");
    },
    targetResolver: {
      looksLikeId: (id) => {
        const trimmed = id?.trim();
        if (!trimmed) return false;
        // LINE user IDs are typically U followed by 32 hex characters
        // Group IDs are C followed by 32 hex characters
        // Room IDs are R followed by 32 hex characters
        return /^[UCR][a-f0-9]{32}$/i.test(trimmed) || /^line:/i.test(trimmed);
      },
      hint: "<userId|groupId|roomId>",
    },
  },
  directory: {
    self: async () => null,
    listPeers: async () => [],
    listGroups: async () => [],
  },
  setup: {
    resolveAccountId: ({ accountId }) =>
      getLineRuntime().channel.line.normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => {
      const lineConfig = (cfg.channels?.line ?? {}) as LineConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            line: {
              ...lineConfig,
              name,
            },
          },
        };
      }
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          line: {
            ...lineConfig,
            accounts: {
              ...lineConfig.accounts,
              [accountId]: {
                ...lineConfig.accounts?.[accountId],
                name,
              },
            },
          },
        },
      };
    },
    validateInput: ({ accountId, input }) => {
      const typedInput = input as {
        useEnv?: boolean;
        channelAccessToken?: string;
        channelSecret?: string;
        tokenFile?: string;
        secretFile?: string;
      };
      if (typedInput.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "LINE_CHANNEL_ACCESS_TOKEN can only be used for the default account.";
      }
      if (!typedInput.useEnv && !typedInput.channelAccessToken && !typedInput.tokenFile) {
        return "LINE requires channelAccessToken or --token-file (or --use-env).";
      }
      if (!typedInput.useEnv && !typedInput.channelSecret && !typedInput.secretFile) {
        return "LINE requires channelSecret or --secret-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const typedInput = input as {
        name?: string;
        useEnv?: boolean;
        channelAccessToken?: string;
        channelSecret?: string;
        tokenFile?: string;
        secretFile?: string;
      };
      const lineConfig = (cfg.channels?.line ?? {}) as LineConfig;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            line: {
              ...lineConfig,
              enabled: true,
              ...(typedInput.name ? { name: typedInput.name } : {}),
              ...(typedInput.useEnv
                ? {}
                : typedInput.tokenFile
                  ? { tokenFile: typedInput.tokenFile }
                  : typedInput.channelAccessToken
                    ? { channelAccessToken: typedInput.channelAccessToken }
                    : {}),
              ...(typedInput.useEnv
                ? {}
                : typedInput.secretFile
                  ? { secretFile: typedInput.secretFile }
                  : typedInput.channelSecret
                    ? { channelSecret: typedInput.channelSecret }
                    : {}),
            },
          },
        };
      }

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          line: {
            ...lineConfig,
            enabled: true,
            accounts: {
              ...lineConfig.accounts,
              [accountId]: {
                ...lineConfig.accounts?.[accountId],
                enabled: true,
                ...(typedInput.name ? { name: typedInput.name } : {}),
                ...(typedInput.tokenFile
                  ? { tokenFile: typedInput.tokenFile }
                  : typedInput.channelAccessToken
                    ? { channelAccessToken: typedInput.channelAccessToken }
                    : {}),
                ...(typedInput.secretFile
                  ? { secretFile: typedInput.secretFile }
                  : typedInput.channelSecret
                    ? { channelSecret: typedInput.channelSecret }
                    : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getLineRuntime().channel.text.chunkMarkdownText(text, limit),
    textChunkLimit: 5000, // LINE allows up to 5000 characters per text message
    sendPayload: async ({ to, payload, accountId, cfg }) => {
      const runtime = getLineRuntime();
      const lineData = (payload.channelData?.line as LineChannelData | undefined) ?? {};
      const sendText = runtime.channel.line.pushMessageLine;
      const sendBatch = runtime.channel.line.pushMessagesLine;
      const sendFlex = runtime.channel.line.pushFlexMessage;
      const sendTemplate = runtime.channel.line.pushTemplateMessage;
      const sendLocation = runtime.channel.line.pushLocationMessage;
      const sendQuickReplies = runtime.channel.line.pushTextMessageWithQuickReplies;
      const buildTemplate = runtime.channel.line.buildTemplateMessageFromPayload;
      const createQuickReplyItems = runtime.channel.line.createQuickReplyItems;

      let lastResult: { messageId: string; chatId: string } | null = null;
      const hasQuickReplies = Boolean(lineData.quickReplies?.length);
      const quickReply = hasQuickReplies
        ? createQuickReplyItems(lineData.quickReplies!)
        : undefined;

      const sendMessageBatch = async (messages: Array<Record<string, unknown>>) => {
        if (messages.length === 0) return;
        for (let i = 0; i < messages.length; i += 5) {
          const result = await sendBatch(to, messages.slice(i, i + 5), {
            verbose: false,
            accountId: accountId ?? undefined,
          });
          lastResult = { messageId: result.messageId, chatId: result.chatId };
        }
      };

      const processed = payload.text
        ? processLineMessage(payload.text)
        : { text: "", flexMessages: [] };

      const chunkLimit =
        runtime.channel.text.resolveTextChunkLimit?.(
          cfg,
          "line",
          accountId ?? undefined,
          {
            fallbackLimit: 5000,
          },
        ) ?? 5000;

      const chunks = processed.text
        ? runtime.channel.text.chunkMarkdownText(processed.text, chunkLimit)
        : [];
      const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      const shouldSendQuickRepliesInline = chunks.length === 0 && hasQuickReplies;

      if (!shouldSendQuickRepliesInline) {
        if (lineData.flexMessage) {
          lastResult = await sendFlex(
            to,
            lineData.flexMessage.altText,
            lineData.flexMessage.contents,
            {
              verbose: false,
              accountId: accountId ?? undefined,
            },
          );
        }

        if (lineData.templateMessage) {
          const template = buildTemplate(lineData.templateMessage);
          if (template) {
            lastResult = await sendTemplate(to, template, {
              verbose: false,
              accountId: accountId ?? undefined,
            });
          }
        }

        if (lineData.location) {
          lastResult = await sendLocation(to, lineData.location, {
            verbose: false,
            accountId: accountId ?? undefined,
          });
        }

        for (const flexMsg of processed.flexMessages) {
          lastResult = await sendFlex(to, flexMsg.altText, flexMsg.contents, {
            verbose: false,
            accountId: accountId ?? undefined,
          });
        }
      }

      const sendMediaAfterText = !(hasQuickReplies && chunks.length > 0);
      if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && !sendMediaAfterText) {
        for (const url of mediaUrls) {
          lastResult = await runtime.channel.line.sendMessageLine(to, "", {
            verbose: false,
            mediaUrl: url,
            accountId: accountId ?? undefined,
          });
        }
      }

      if (chunks.length > 0) {
        for (let i = 0; i < chunks.length; i += 1) {
          const isLast = i === chunks.length - 1;
          if (isLast && hasQuickReplies) {
            lastResult = await sendQuickReplies(to, chunks[i]!, lineData.quickReplies!, {
              verbose: false,
              accountId: accountId ?? undefined,
            });
          } else {
            lastResult = await sendText(to, chunks[i]!, {
              verbose: false,
              accountId: accountId ?? undefined,
            });
          }
        }
      } else if (shouldSendQuickRepliesInline) {
        const quickReplyMessages: Array<Record<string, unknown>> = [];
        if (lineData.flexMessage) {
          quickReplyMessages.push({
            type: "flex",
            altText: lineData.flexMessage.altText.slice(0, 400),
            contents: lineData.flexMessage.contents,
          });
        }
        if (lineData.templateMessage) {
          const template = buildTemplate(lineData.templateMessage);
          if (template) {
            quickReplyMessages.push(template);
          }
        }
        if (lineData.location) {
          quickReplyMessages.push({
            type: "location",
            title: lineData.location.title.slice(0, 100),
            address: lineData.location.address.slice(0, 100),
            latitude: lineData.location.latitude,
            longitude: lineData.location.longitude,
          });
        }
        for (const flexMsg of processed.flexMessages) {
          quickReplyMessages.push({
            type: "flex",
            altText: flexMsg.altText.slice(0, 400),
            contents: flexMsg.contents,
          });
        }
        for (const url of mediaUrls) {
          const trimmed = url?.trim();
          if (!trimmed) continue;
          quickReplyMessages.push({
            type: "image",
            originalContentUrl: trimmed,
            previewImageUrl: trimmed,
          });
        }
        if (quickReplyMessages.length > 0 && quickReply) {
          const lastIndex = quickReplyMessages.length - 1;
          quickReplyMessages[lastIndex] = {
            ...quickReplyMessages[lastIndex],
            quickReply,
          };
          await sendMessageBatch(quickReplyMessages);
        }
      }

      if (mediaUrls.length > 0 && !shouldSendQuickRepliesInline && sendMediaAfterText) {
        for (const url of mediaUrls) {
          lastResult = await runtime.channel.line.sendMessageLine(to, "", {
            verbose: false,
            mediaUrl: url,
            accountId: accountId ?? undefined,
          });
        }
      }

      if (lastResult) return { channel: "line", ...lastResult };
      return { channel: "line", messageId: "empty", chatId: to };
    },
    sendText: async ({ to, text, accountId }) => {
      const runtime = getLineRuntime();
      const sendText = runtime.channel.line.pushMessageLine;
      const sendFlex = runtime.channel.line.pushFlexMessage;

      // Process markdown: extract tables/code blocks, strip formatting
      const processed = processLineMessage(text);

      // Send cleaned text first (if non-empty)
      let result: { messageId: string; chatId: string };
      if (processed.text.trim()) {
        result = await sendText(to, processed.text, {
          verbose: false,
          accountId: accountId ?? undefined,
        });
      } else {
        // If text is empty after processing, still need a result
        result = { messageId: "processed", chatId: to };
      }

      // Send flex messages for tables/code blocks
      for (const flexMsg of processed.flexMessages) {
        await sendFlex(to, flexMsg.altText, flexMsg.contents, {
          verbose: false,
          accountId: accountId ?? undefined,
        });
      }

      return { channel: "line", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      const send = getLineRuntime().channel.line.sendMessageLine;
      const result = await send(to, text, {
        verbose: false,
        mediaUrl,
        accountId: accountId ?? undefined,
      });
      return { channel: "line", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: ({ account }) => {
      const issues: Array<{ level: "error" | "warning"; message: string }> = [];
      if (!account.channelAccessToken?.trim()) {
        issues.push({
          level: "error",
          message: "LINE channel access token not configured",
        });
      }
      if (!account.channelSecret?.trim()) {
        issues.push({
          level: "error",
          message: "LINE channel secret not configured",
        });
      }
      return issues;
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      getLineRuntime().channel.line.probeLineBot(account.channelAccessToken, timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(account.channelAccessToken?.trim());
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        tokenSource: account.tokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: "webhook",
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const token = account.channelAccessToken.trim();
      const secret = account.channelSecret.trim();

      let lineBotLabel = "";
      try {
        const probe = await getLineRuntime().channel.line.probeLineBot(token, 2500);
        const displayName = probe.ok ? probe.bot?.displayName?.trim() : null;
        if (displayName) lineBotLabel = ` (${displayName})`;
      } catch (err) {
        if (getLineRuntime().logging.shouldLogVerbose()) {
          ctx.log?.debug?.(`[${account.accountId}] bot probe failed: ${String(err)}`);
        }
      }

      ctx.log?.info(`[${account.accountId}] starting LINE provider${lineBotLabel}`);

      return getLineRuntime().channel.line.monitorLineProvider({
        channelAccessToken: token,
        channelSecret: secret,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        webhookPath: account.config.webhookPath,
      });
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const envToken = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim() ?? "";
      const nextCfg = { ...cfg } as MoltbotConfig;
      const lineConfig = (cfg.channels?.line ?? {}) as LineConfig;
      const nextLine = { ...lineConfig };
      let cleared = false;
      let changed = false;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        if (
          nextLine.channelAccessToken ||
          nextLine.channelSecret ||
          nextLine.tokenFile ||
          nextLine.secretFile
        ) {
          delete nextLine.channelAccessToken;
          delete nextLine.channelSecret;
          delete nextLine.tokenFile;
          delete nextLine.secretFile;
          cleared = true;
          changed = true;
        }
      }

      const accounts = nextLine.accounts ? { ...nextLine.accounts } : undefined;
      if (accounts && accountId in accounts) {
        const entry = accounts[accountId];
        if (entry && typeof entry === "object") {
          const nextEntry = { ...entry } as Record<string, unknown>;
          if (
            "channelAccessToken" in nextEntry ||
            "channelSecret" in nextEntry ||
            "tokenFile" in nextEntry ||
            "secretFile" in nextEntry
          ) {
            cleared = true;
            delete nextEntry.channelAccessToken;
            delete nextEntry.channelSecret;
            delete nextEntry.tokenFile;
            delete nextEntry.secretFile;
            changed = true;
          }
          if (Object.keys(nextEntry).length === 0) {
            delete accounts[accountId];
            changed = true;
          } else {
            accounts[accountId] = nextEntry as typeof entry;
          }
        }
      }

      if (accounts) {
        if (Object.keys(accounts).length === 0) {
          delete nextLine.accounts;
          changed = true;
        } else {
          nextLine.accounts = accounts;
        }
      }

      if (changed) {
        if (Object.keys(nextLine).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, line: nextLine };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete (nextChannels as Record<string, unknown>).line;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
        await getLineRuntime().config.writeConfigFile(nextCfg);
      }

      const resolved = getLineRuntime().channel.line.resolveLineAccount({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = resolved.tokenSource === "none";

      return { cleared, envToken: Boolean(envToken), loggedOut };
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "",
      "### LINE Rich Messages",
      "LINE supports rich visual messages. Use these directives in your reply when appropriate:",
      "",
      "**Quick Replies** (bottom button suggestions):",
      "  [[quick_replies: Option 1, Option 2, Option 3]]",
      "",
      "**Location** (map pin):",
      "  [[location: Place Name | Address | latitude | longitude]]",
      "",
      "**Confirm Dialog** (yes/no prompt):",
      "  [[confirm: Question text? | Yes Label | No Label]]",
      "",
      "**Button Menu** (title + text + buttons):",
      "  [[buttons: Title | Description | Btn1:action1, Btn2:https://url.com]]",
      "",
      "**Media Player Card** (music status):",
      "  [[media_player: Song Title | Artist Name | Source | https://albumart.url | playing]]",
      "  - Status: 'playing' or 'paused' (optional)",
      "",
      "**Event Card** (calendar events, meetings):",
      "  [[event: Event Title | Date | Time | Location | Description]]",
      "  - Time, Location, Description are optional",
      "",
      "**Agenda Card** (multiple events/schedule):",
      "  [[agenda: Schedule Title | Event1:9:00 AM, Event2:12:00 PM, Event3:3:00 PM]]",
      "",
      "**Device Control Card** (smart devices, TVs, etc.):",
      "  [[device: Device Name | Device Type | Status | Control1:data1, Control2:data2]]",
      "",
      "**Apple TV Remote** (full D-pad + transport):",
      "  [[appletv_remote: Apple TV | Playing]]",
      "",
      "**Auto-converted**: Markdown tables become Flex cards, code blocks become styled cards.",
      "",
      "When to use rich messages:",
      "- Use [[quick_replies:...]] when offering 2-4 clear options",
      "- Use [[confirm:...]] for yes/no decisions",
      "- Use [[buttons:...]] for menus with actions/links",
      "- Use [[location:...]] when sharing a place",
      "- Use [[media_player:...]] when showing what's playing",
      "- Use [[event:...]] for calendar event details",
      "- Use [[agenda:...]] for a day's schedule or event list",
      "- Use [[device:...]] for smart device status/controls",
      "- Tables/code in your response auto-convert to visual cards",
    ],
  },
};
