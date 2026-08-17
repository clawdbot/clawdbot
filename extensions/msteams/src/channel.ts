// Msteams plugin module implements channel behavior.
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createAccountStatusSink,
  createChannelMessageAdapterFromOutbound,
  createRuntimeOutboundDelegates,
} from "openclaw/plugin-sdk/channel-outbound";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createConditionalWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import {
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { msteamsDirectoryContractPlugin } from "../directory-contract-api.js";
import type {
  ChannelMessageActionName,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../runtime-api.js";
import {
  buildProbeChannelStatusSummary,
  chunkTextForOutbound,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
} from "../runtime-api.js";
import {
  resolveDefaultMSTeamsAccountId,
  resolveMSTeamsAccount,
  resolveMSTeamsAccountConfig,
} from "./accounts.js";
import {
  extractMSTeamsToolSendResult,
  msteamsContextTargetsMatch,
  resolveMSTeamsAutoThreadId,
} from "./action-threading.js";
import { msTeamsApprovalAuth } from "./approval-auth.js";
import type { ResolvedMSTeamsAccount } from "./channel-config.js";
import { describeMSTeamsMessageTool } from "./channel-message-tool.js";
import { createMSTeamsSecurityWarningCollector } from "./channel-security.js";
import { msteamsSetupPlugin } from "./channel.setup.js";
import { collectMSTeamsMutableAllowlistWarnings } from "./doctor.js";
import { resolveMSTeamsGroupToolPolicy } from "./policy.js";
import { buildMSTeamsPresentationCard, MSTEAMS_PRESENTATION_CAPABILITIES } from "./presentation.js";
import type { ProbeMSTeamsResult } from "./probe.js";
import {
  assertMSTeamsReadTargetAllowed,
  assertMSTeamsTeamEnumerationAllowed,
  isCurrentMSTeamsReadTarget,
} from "./read-policy.js";
import {
  normalizeMSTeamsMessagingTarget,
  normalizeMSTeamsUserInput,
  looksLikeMSTeamsTargetId,
  parseMSTeamsConversationId,
  parseMSTeamsTeamChannelInput,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";
import { inferMSTeamsTargetChatType, resolveMSTeamsOutboundSessionRoute } from "./session-route.js";
import { resolveMSTeamsCredentials } from "./token.js";

const TEAMS_GRAPH_PERMISSION_HINTS: Record<string, string> = {
  "ChannelMessage.Read.All": "channel history",
  "Chat.Read.All": "chat history",
  "Channel.ReadBasic.All": "channel list",
  "Team.ReadBasic.All": "team list",
  "TeamsActivity.Read.All": "teams activity",
  "Sites.Read.All": "files (SharePoint)",
  "Files.Read.All": "files (OneDrive)",
};

const MSTEAMS_GROUP_MANAGEMENT_ACTIONS = new Set<ChannelMessageActionName>([
  "addParticipant",
  "removeParticipant",
  "renameGroup",
]);

const collectMSTeamsSecurityFindings = createMSTeamsSecurityWarningCollector(
  createConditionalWarningCollector.findings,
);

const loadMSTeamsChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "msTeamsChannelRuntime",
);

function jsonActionResult(data: Record<string, unknown>) {
  const text = JSON.stringify(data);
  return {
    content: [{ type: "text" as const, text }],
    details: data,
  };
}

function jsonMSTeamsActionResult(action: string, data: Record<string, unknown> = {}) {
  return jsonActionResult({ channel: "msteams", action, ...data });
}

function jsonMSTeamsOkActionResult(action: string, data: Record<string, unknown> = {}) {
  return jsonActionResult({ ok: true, channel: "msteams", action, ...data });
}

function jsonMSTeamsConversationResult(conversationId: string | undefined) {
  return jsonActionResultWithDetails(
    {
      ok: true,
      channel: "msteams",
      conversationId,
    },
    { ok: true, channel: "msteams" },
  );
}

function jsonActionResultWithDetails(
  contentData: Record<string, unknown>,
  details: Record<string, unknown>,
) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(contentData) }],
    details,
  };
}

const MSTEAMS_REACTION_TYPES = ["like", "heart", "laugh", "surprised", "sad", "angry"] as const;

function actionError(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
    details: { error: message },
  };
}

function requireMSTeamsGroupManagementAuthorization(ctx: {
  senderIsOwner?: boolean;
  gatewayClientScopes?: readonly string[];
}): ReturnType<typeof actionError> | null {
  if (ctx.senderIsOwner === true || ctx.gatewayClientScopes?.includes("operator.admin")) {
    return null;
  }
  return actionError(
    "Microsoft Teams group management requires an owner or operator.admin requester.",
  );
}

function resolveActionTarget(
  params: Record<string, unknown>,
  currentChannelId?: string | null,
): string {
  return typeof params.to === "string"
    ? params.to.trim()
    : typeof params.target === "string"
      ? params.target.trim()
      : (currentChannelId?.trim() ?? "");
}

function resolveGraphActionTarget(
  params: Record<string, unknown>,
  currentChannelId?: string | null,
  currentGraphChannelId?: string | null,
  currentChatType?: "direct" | "group" | "channel" | null,
): string {
  const explicitTarget = resolveActionTarget(params);
  const currentChannelTarget = currentChannelId?.trim();
  const currentGraphTarget = currentGraphChannelId?.trim();
  if (explicitTarget) {
    // Core materializes omitted action targets as currentChannelId before
    // plugin dispatch. Restore the prepared Graph route for channel actions.
    if (
      currentChatType === "channel" &&
      currentGraphTarget &&
      currentChannelTarget &&
      explicitTarget === currentChannelTarget
    ) {
      return currentGraphTarget;
    }
    return explicitTarget;
  }
  if (currentGraphTarget) {
    return currentGraphTarget;
  }
  return currentChatType === "channel" ? "" : (currentChannelTarget ?? "");
}

function resolveCurrentGraphActionTarget(toolContext?: {
  currentGraphChannelId?: string;
  currentMessagingTarget?: string;
}): string | undefined {
  return (
    normalizeOptionalString(toolContext?.currentGraphChannelId) ??
    normalizeOptionalString(toolContext?.currentMessagingTarget)
  );
}

function resolveActionMessageId(params: Record<string, unknown>): string {
  return normalizeOptionalString(params.messageId) ?? "";
}

function resolveActionPinnedMessageId(params: Record<string, unknown>): string {
  return typeof params.pinnedMessageId === "string"
    ? params.pinnedMessageId.trim()
    : typeof params.messageId === "string"
      ? params.messageId.trim()
      : "";
}

function resolveActionQuery(params: Record<string, unknown>): string {
  return normalizeOptionalString(params.query) ?? "";
}

function resolveActionContent(params: Record<string, unknown>): string {
  return typeof params.text === "string"
    ? params.text
    : typeof params.content === "string"
      ? params.content
      : typeof params.message === "string"
        ? params.message
        : "";
}

function readOptionalTrimmedString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  return normalizeOptionalString(params[key]);
}

function resolveActionUploadFilePath(params: Record<string, unknown>): string | undefined {
  for (const key of ["filePath", "path", "media"] as const) {
    if (typeof params[key] === "string") {
      const value = params[key];
      if (value.trim()) {
        return value;
      }
    }
  }
  return undefined;
}

type MSTeamsActionTargetParams = {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
  currentGraphChannelId?: string | null;
  currentChatType?: "direct" | "group" | "channel" | null;
  graphOnly?: boolean;
};

function resolveMSTeamsActionTarget(params: MSTeamsActionTargetParams): string {
  return params.graphOnly
    ? resolveGraphActionTarget(
        params.toolParams,
        params.currentChannelId,
        params.currentGraphChannelId,
        params.currentChatType,
      )
    : resolveActionTarget(params.toolParams, params.currentChannelId);
}

async function runWithRequiredActionTarget<T>(
  params: MSTeamsActionTargetParams & { run: (to: string) => Promise<T> },
): Promise<T | ReturnType<typeof actionError>> {
  const to = resolveMSTeamsActionTarget(params);
  if (!to) {
    return actionError(`${params.actionLabel} requires a target (to).`);
  }
  return await params.run(to);
}

async function runWithRequiredActionMessageTarget<T>(
  params: MSTeamsActionTargetParams & {
    run: (target: { to: string; messageId: string }) => Promise<T>;
  },
): Promise<T | ReturnType<typeof actionError>> {
  const to = resolveMSTeamsActionTarget(params);
  const messageId = resolveActionMessageId(params.toolParams);
  if (!to || !messageId) {
    return actionError(`${params.actionLabel} requires a target (to) and messageId.`);
  }
  return await params.run({ to, messageId });
}

async function runWithRequiredActionPinnedMessageTarget<T>(
  params: MSTeamsActionTargetParams & {
    run: (target: { to: string; pinnedMessageId: string }) => Promise<T>;
  },
): Promise<T | ReturnType<typeof actionError>> {
  const to = resolveMSTeamsActionTarget(params);
  const pinnedMessageId = resolveActionPinnedMessageId(params.toolParams);
  if (!to || !pinnedMessageId) {
    return actionError(`${params.actionLabel} requires a target (to) and pinnedMessageId.`);
  }
  return await params.run({ to, pinnedMessageId });
}

const msteamsChannelOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  resolveEffectiveTextChunkLimit: ({ fallbackLimit }) =>
    typeof fallbackLimit === "number" && fallbackLimit > 0 ? Math.min(fallbackLimit, 4000) : 4000,
  pollMaxOptions: 12,
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      payload: true,
      messageSendingHooks: true,
    },
  },
  presentationCapabilities: MSTEAMS_PRESENTATION_CAPABILITIES,
  ...createRuntimeOutboundDelegates({
    getRuntime: loadMSTeamsChannelRuntime,
    renderPresentation: { resolve: (runtime) => runtime.msteamsOutbound.renderPresentation },
    sendPayload: { resolve: (runtime) => runtime.msteamsOutbound.sendPayload },
    sendText: { resolve: (runtime) => runtime.msteamsOutbound.sendText },
    sendMedia: { resolve: (runtime) => runtime.msteamsOutbound.sendMedia },
    sendPoll: { resolve: (runtime) => runtime.msteamsOutbound.sendPoll },
  }),
};

const msteamsMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "msteams",
  outbound: msteamsChannelOutbound,
  live: {
    capabilities: {
      draftPreview: true,
      previewFinalization: true,
      progressUpdates: true,
      nativeStreaming: true,
    },
    finalizer: {
      capabilities: {
        finalEdit: true,
        normalFallback: true,
        previewReceipt: true,
      },
    },
  },
});

export const msteamsPlugin: ChannelPlugin<ResolvedMSTeamsAccount, ProbeMSTeamsResult> =
  createChatChannelPlugin({
    base: {
      ...msteamsSetupPlugin,
      streaming: {
        blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
      },
      agentPrompt: {
        messageToolHints: () => [
          "- Adaptive Cards supported. Use `action=send` with `card={type,version,body}` to send rich cards.",
          "- MSTeams targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:ID` or `user:Display Name` (requires Graph API) for DMs, `conversation:19:...@thread.tacv2` for groups/channels. Prefer IDs over display names for speed.",
        ],
      },
      groups: {
        resolveToolPolicy: resolveMSTeamsGroupToolPolicy,
      },
      approvalCapability: msTeamsApprovalAuth,
      doctor: {
        dmAllowFromMode: "topOnly",
        groupModel: "hybrid",
        groupAllowFromFallbackToAllowFrom: true,
        warnOnEmptyGroupSenderAllowlist: true,
        collectMutableAllowlistWarnings: collectMSTeamsMutableAllowlistWarnings,
      },
      messaging: {
        targetPrefixes: ["msteams", "teams"],
        directTargetStyle: "user-prefixed",
        normalizeTarget: normalizeMSTeamsMessagingTarget,
        inferTargetChatType: ({ to }) => inferMSTeamsTargetChatType(to),
        resolveOutboundSessionRoute: (params) => resolveMSTeamsOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: (raw) => looksLikeMSTeamsTargetId(raw),
          hint: "<conversationId|user:ID|conversation:ID>",
        },
      },
      message: msteamsMessageAdapter,
      directory: createChannelDirectoryAdapter({
        ...msteamsDirectoryContractPlugin.directory,
        ...createRuntimeDirectoryLiveAdapter({
          getRuntime: loadMSTeamsChannelRuntime,
          listPeersLive: (runtime) => runtime.listMSTeamsDirectoryPeersLive,
          listGroupsLive: (runtime) => runtime.listMSTeamsDirectoryGroupsLive,
        }),
      }),
      resolver: {
        resolveTargets: async ({ cfg, accountId, inputs, kind, runtime }) => {
          const scopedCfg = {
            ...cfg,
            channels: {
              ...cfg.channels,
              msteams: resolveMSTeamsAccountConfig(cfg, accountId),
            },
          };
          const results = inputs.map((input) => ({
            input,
            resolved: false,
            id: undefined as string | undefined,
            name: undefined as string | undefined,
            note: undefined as string | undefined,
          }));
          type ResolveTargetResultEntry = (typeof results)[number];
          type PendingTargetEntry = { input: string; query: string; index: number };

          const stripPrefix = (value: string) => normalizeMSTeamsUserInput(value);
          const markPendingLookupFailed = (pending: PendingTargetEntry[]) => {
            pending.forEach(({ index }) => {
              const entry = results[index];
              if (entry) {
                entry.note = "lookup failed";
              }
            });
          };
          const resolvePending = async <T>(
            pending: PendingTargetEntry[],
            resolveEntries: (entries: string[]) => Promise<T[]>,
            applyResolvedEntry: (target: ResolveTargetResultEntry, entry: T) => void,
          ) => {
            if (pending.length === 0) {
              return;
            }
            try {
              const resolved = await resolveEntries(pending.map((entry) => entry.query));
              resolved.forEach((entry, idx) => {
                const target = results[pending[idx]?.index ?? -1];
                if (!target) {
                  return;
                }
                applyResolvedEntry(target, entry);
              });
            } catch (err) {
              runtime.error?.(`msteams resolve failed: ${String(err)}`);
              markPendingLookupFailed(pending);
            }
          };

          if (kind === "user") {
            const pending: PendingTargetEntry[] = [];
            results.forEach((entry, index) => {
              const trimmed = entry.input.trim();
              if (!trimmed) {
                entry.note = "empty input";
                return;
              }
              const cleaned = stripPrefix(trimmed);
              if (/^[0-9a-fA-F-]{16,}$/.test(cleaned) || cleaned.includes("@")) {
                entry.resolved = true;
                entry.id = cleaned;
                return;
              }
              pending.push({ input: entry.input, query: cleaned, index });
            });

            await resolvePending(
              pending,
              (entries) => resolveMSTeamsUserAllowlist({ cfg: scopedCfg, entries }),
              (target, entry) => {
                target.resolved = entry.resolved;
                target.id = entry.id;
                target.name = entry.name;
                target.note = entry.note;
              },
            );

            return results;
          }

          const pending: PendingTargetEntry[] = [];
          results.forEach((entry, index) => {
            const trimmed = entry.input.trim();
            if (!trimmed) {
              entry.note = "empty input";
              return;
            }
            const conversationId = parseMSTeamsConversationId(trimmed);
            if (conversationId !== null) {
              entry.resolved = Boolean(conversationId);
              entry.id = conversationId || undefined;
              entry.note = conversationId ? "conversation id" : "empty conversation id";
              return;
            }
            const parsed = parseMSTeamsTeamChannelInput(trimmed);
            if (!parsed.team) {
              entry.note = "missing team";
              return;
            }
            const query = parsed.channel ? `${parsed.team}/${parsed.channel}` : parsed.team;
            pending.push({ input: entry.input, query, index });
          });

          await resolvePending(
            pending,
            (entries) => resolveMSTeamsChannelAllowlist({ cfg: scopedCfg, entries }),
            (target, entry) => {
              if (!entry.resolved || !entry.teamId) {
                target.resolved = false;
                target.note = entry.note;
                return;
              }
              target.resolved = true;
              if (entry.channelId) {
                target.id = `${entry.teamId}/${entry.channelId}`;
                target.name =
                  entry.channelName && entry.teamName
                    ? `${entry.teamName}/${entry.channelName}`
                    : (entry.channelName ?? entry.teamName);
              } else {
                target.id = entry.teamId;
                target.name = entry.teamName;
                target.note = "team id";
              }
              if (entry.note) {
                target.note = entry.note;
              }
            },
          );

          return results;
        },
      },
      actions: {
        providerOwnedReadGates: true,
        describeMessageTool: describeMSTeamsMessageTool,
        extractToolSendResult: ({ result, send }) => extractMSTeamsToolSendResult(result, send),
        requiresTrustedRequesterSender: ({ action, toolContext }) =>
          normalizeOptionalString(toolContext?.currentChannelProvider)?.toLowerCase() ===
            "msteams" && MSTEAMS_GROUP_MANAGEMENT_ACTIONS.has(action),
        handleAction: async (ctx) => {
          if (MSTEAMS_GROUP_MANAGEMENT_ACTIONS.has(ctx.action)) {
            const authError = requireMSTeamsGroupManagementAuthorization(ctx);
            if (authError) {
              return authError;
            }
          }
          const accountId = ctx.accountId ?? resolveDefaultMSTeamsAccountId(ctx.cfg);
          const actionAccountId = accountId === DEFAULT_ACCOUNT_ID ? undefined : accountId;
          const authorizeActionTarget = (target: string) =>
            assertMSTeamsReadTargetAllowed({ cfg: ctx.cfg, ctx, target });
          const presentation =
            ctx.action === "send"
              ? normalizeMessagePresentation(ctx.params.presentation)
              : undefined;
          if (ctx.action === "send" && presentation) {
            const card = buildMSTeamsPresentationCard({
              presentation,
              text: resolveActionContent(ctx.params),
            });
            return await runWithRequiredActionTarget({
              actionLabel: "Card send",
              toolParams: ctx.params,
              run: async (to) => {
                const { sendAdaptiveCardMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await sendAdaptiveCardMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to,
                  card,
                });
                return jsonActionResultWithDetails(
                  {
                    ok: true,
                    channel: "msteams",
                    messageId: result.messageId,
                    conversationId: result.conversationId,
                  },
                  { ok: true, channel: "msteams", messageId: result.messageId },
                );
              },
            });
          }
          if (ctx.action === "upload-file") {
            const mediaUrl = resolveActionUploadFilePath(ctx.params);
            if (!mediaUrl) {
              return actionError("Upload-file requires media, filePath, or path.");
            }
            return await runWithRequiredActionTarget({
              actionLabel: "Upload-file",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (to) => {
                const { sendMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await sendMessageMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to,
                  text: resolveActionContent(ctx.params),
                  mediaUrl,
                  filename:
                    readOptionalTrimmedString(ctx.params, "filename") ??
                    readOptionalTrimmedString(ctx.params, "title"),
                  mediaAccess: ctx.mediaAccess,
                  mediaLocalRoots: ctx.mediaLocalRoots,
                  mediaReadFile: ctx.mediaReadFile,
                });
                return jsonActionResultWithDetails(
                  {
                    ok: true,
                    channel: "msteams",
                    action: "upload-file",
                    messageId: result.messageId,
                    conversationId: result.conversationId,
                    ...(result.pendingUploadId ? { pendingUploadId: result.pendingUploadId } : {}),
                  },
                  {
                    ok: true,
                    channel: "msteams",
                    messageId: result.messageId,
                    ...(result.pendingUploadId ? { pendingUploadId: result.pendingUploadId } : {}),
                  },
                );
              },
            });
          }
          if (ctx.action === "edit") {
            const content = resolveActionContent(ctx.params);
            if (!content) {
              return actionError("Edit requires content.");
            }
            return await runWithRequiredActionMessageTarget({
              actionLabel: "Edit",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (target) => {
                const to = await authorizeActionTarget(target.to);
                const { editMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await editMessageMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to,
                  activityId: target.messageId,
                  text: content,
                });
                return jsonMSTeamsConversationResult(result.conversationId);
              },
            });
          }

          if (ctx.action === "delete") {
            return await runWithRequiredActionMessageTarget({
              actionLabel: "Delete",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (target) => {
                const to = await authorizeActionTarget(target.to);
                const { deleteMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await deleteMessageMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to,
                  activityId: target.messageId,
                });
                return jsonMSTeamsConversationResult(result.conversationId);
              },
            });
          }

          const graphActionTarget = {
            toolParams: ctx.params,
            currentChannelId: ctx.toolContext?.currentChannelId,
            currentGraphChannelId: resolveCurrentGraphActionTarget(ctx.toolContext),
            currentChatType: ctx.toolContext?.currentChatType,
            graphOnly: true,
          };

          if (ctx.action === "read") {
            return await runWithRequiredActionMessageTarget({
              actionLabel: "Read",
              ...graphActionTarget,
              run: async (target) => {
                const to = await authorizeActionTarget(target.to);
                const { getMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const message = await getMessageMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to,
                  messageId: target.messageId,
                });
                return jsonMSTeamsOkActionResult("read", { message });
              },
            });
          }

          if (ctx.action === "pin") {
            return await runWithRequiredActionMessageTarget({
              actionLabel: "Pin",
              ...graphActionTarget,
              run: async (target) => {
                const to = await authorizeActionTarget(target.to);
                const { pinMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await pinMessageMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to,
                  messageId: target.messageId,
                });
                return jsonMSTeamsActionResult("pin", result);
              },
            });
          }

          if (ctx.action === "unpin") {
            return await runWithRequiredActionPinnedMessageTarget({
              actionLabel: "Unpin",
              ...graphActionTarget,
              run: async (target) => {
                const to = await authorizeActionTarget(target.to);
                const { unpinMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await unpinMessageMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to,
                  pinnedMessageId: target.pinnedMessageId,
                });
                return jsonMSTeamsActionResult("unpin", result);
              },
            });
          }

          if (ctx.action === "list-pins") {
            return await runWithRequiredActionTarget({
              actionLabel: "List-pins",
              ...graphActionTarget,
              run: async (to) => {
                const allowedTarget = await authorizeActionTarget(to);
                const { listPinsMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await listPinsMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to: allowedTarget,
                });
                return jsonMSTeamsOkActionResult("list-pins", result);
              },
            });
          }

          if (ctx.action === "react") {
            return await runWithRequiredActionMessageTarget({
              actionLabel: "React",
              ...graphActionTarget,
              run: async (target) => {
                const emoji = typeof ctx.params.emoji === "string" ? ctx.params.emoji.trim() : "";
                const remove = typeof ctx.params.remove === "boolean" ? ctx.params.remove : false;
                if (!emoji) {
                  return {
                    isError: true,
                    content: [
                      {
                        type: "text" as const,
                        text: `React requires an emoji (reaction type). Valid types: ${MSTEAMS_REACTION_TYPES.join(", ")}.`,
                      },
                    ],
                    details: {
                      error: "React requires an emoji (reaction type).",
                      validTypes: [...MSTEAMS_REACTION_TYPES],
                    },
                  };
                }
                const to = await authorizeActionTarget(target.to);
                if (remove) {
                  const { unreactMessageMSTeams } = await loadMSTeamsChannelRuntime();
                  const result = await unreactMessageMSTeams({
                    cfg: ctx.cfg,
                    accountId: actionAccountId,
                    to,
                    messageId: target.messageId,
                    reactionType: emoji,
                  });
                  return jsonMSTeamsActionResult("react", {
                    removed: true,
                    reactionType: emoji,
                    ...result,
                  });
                }
                const { reactMessageMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await reactMessageMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to,
                  messageId: target.messageId,
                  reactionType: emoji,
                });
                return jsonMSTeamsActionResult("react", {
                  reactionType: emoji,
                  ...result,
                });
              },
            });
          }

          if (ctx.action === "reactions") {
            return await runWithRequiredActionMessageTarget({
              actionLabel: "Reactions",
              ...graphActionTarget,
              run: async (target) => {
                const to = await authorizeActionTarget(target.to);
                const { listReactionsMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await listReactionsMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to,
                  messageId: target.messageId,
                });
                return jsonMSTeamsOkActionResult("reactions", result);
              },
            });
          }

          if (ctx.action === "search") {
            return await runWithRequiredActionTarget({
              actionLabel: "Search",
              ...graphActionTarget,
              run: async (to) => {
                const allowedTarget = await authorizeActionTarget(to);
                const query = resolveActionQuery(ctx.params);
                if (!query) {
                  return actionError("Search requires a target (to) and query.");
                }
                const limit = typeof ctx.params.limit === "number" ? ctx.params.limit : undefined;
                const from =
                  typeof ctx.params.from === "string" ? ctx.params.from.trim() : undefined;
                const { searchMessagesMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await searchMessagesMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to: allowedTarget,
                  query,
                  from: from || undefined,
                  limit,
                });
                return jsonMSTeamsOkActionResult("search", result);
              },
            });
          }

          if (ctx.action === "member-info") {
            const userId = normalizeOptionalString(ctx.params.userId) ?? "";
            if (!userId) {
              return actionError("member-info requires a userId.");
            }
            return await runWithRequiredActionTarget({
              actionLabel: "member-info",
              ...graphActionTarget,
              run: async (target) => {
                const to = await authorizeActionTarget(target);
                const currentRequesterId = isCurrentMSTeamsReadTarget({ ctx, target: to })
                  ? ctx.requesterSenderId
                  : undefined;
                const { getMemberInfoMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await getMemberInfoMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to,
                  userId,
                  currentRequesterId,
                });
                return jsonMSTeamsOkActionResult("member-info", result);
              },
            });
          }

          if (ctx.action === "channel-list") {
            const teamId = normalizeOptionalString(ctx.params.teamId) ?? "";
            if (!teamId) {
              return actionError("channel-list requires a teamId.");
            }
            const graphTeamId = await assertMSTeamsTeamEnumerationAllowed({
              cfg: ctx.cfg,
              ctx,
              teamId,
            });
            const { listChannelsMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await listChannelsMSTeams({
              cfg: ctx.cfg,
              accountId: actionAccountId,
              teamId: graphTeamId,
            });
            return jsonMSTeamsOkActionResult("channel-list", result);
          }

          if (ctx.action === "channel-info") {
            const teamId = normalizeOptionalString(ctx.params.teamId) ?? "";
            const channelId = normalizeOptionalString(ctx.params.channelId) ?? "";
            if (!teamId || !channelId) {
              return actionError("channel-info requires teamId and channelId.");
            }
            const graphTarget = await authorizeActionTarget(`${teamId}/${channelId}`);
            const [graphTeamId, graphChannelId] = graphTarget.split("/", 2);
            if (!graphTeamId || !graphChannelId) {
              throw new Error("Authorized Microsoft Teams channel target is invalid.");
            }
            const { getChannelInfoMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await getChannelInfoMSTeams({
              cfg: ctx.cfg,
              accountId: actionAccountId,
              teamId: graphTeamId,
              channelId: graphChannelId,
            });
            return jsonMSTeamsOkActionResult("channel-info", {
              channelInfo: result.channel,
            });
          }

          if (ctx.action === "addParticipant") {
            const userId = typeof ctx.params.userId === "string" ? ctx.params.userId.trim() : "";
            if (!userId) {
              return actionError("addParticipant requires a userId.");
            }
            return await runWithRequiredActionTarget({
              actionLabel: "addParticipant",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (to) => {
                const role = readOptionalTrimmedString(ctx.params, "role");
                const { addParticipantMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await addParticipantMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to,
                  userId,
                  role,
                });
                return jsonMSTeamsOkActionResult("addParticipant", result);
              },
            });
          }

          if (ctx.action === "removeParticipant") {
            const userId = typeof ctx.params.userId === "string" ? ctx.params.userId.trim() : "";
            if (!userId) {
              return actionError("removeParticipant requires a userId.");
            }
            return await runWithRequiredActionTarget({
              actionLabel: "removeParticipant",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (to) => {
                const { removeParticipantMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await removeParticipantMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to,
                  userId,
                });
                return jsonMSTeamsOkActionResult("removeParticipant", result);
              },
            });
          }

          if (ctx.action === "renameGroup") {
            const name = typeof ctx.params.name === "string" ? ctx.params.name.trim() : "";
            if (!name) {
              return actionError("renameGroup requires a name.");
            }
            return await runWithRequiredActionTarget({
              actionLabel: "renameGroup",
              toolParams: ctx.params,
              currentChannelId: ctx.toolContext?.currentChannelId,
              run: async (to) => {
                const { renameGroupMSTeams } = await loadMSTeamsChannelRuntime();
                const result = await renameGroupMSTeams({
                  cfg: ctx.cfg,
                  accountId: actionAccountId,
                  to,
                  name,
                });
                return jsonMSTeamsOkActionResult("renameGroup", result);
              },
            });
          }

          // Return null to fall through to default handler
          return null as never;
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedMSTeamsAccount, ProbeMSTeamsResult>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, { port: null }),
        buildChannelSummary: ({ snapshot }) =>
          buildProbeChannelStatusSummary(snapshot, {
            port: snapshot.port ?? null,
          }),
        probeAccount: async ({ account }) =>
          await (
            await loadMSTeamsChannelRuntime()
          ).probeMSTeams(account.config, {
            accountId: account.accountId,
          }),
        formatCapabilitiesProbe: ({ probe }) => {
          const teamsProbe = probe;
          const lines: Array<{ text: string; tone?: "error" }> = [];
          const appId = typeof teamsProbe?.appId === "string" ? teamsProbe.appId.trim() : "";
          if (appId) {
            lines.push({ text: `App: ${appId}` });
          }
          const graph = teamsProbe?.graph;
          if (graph) {
            const roles = Array.isArray(graph.roles) ? normalizeStringEntries(graph.roles) : [];
            const scopes = Array.isArray(graph.scopes) ? normalizeStringEntries(graph.scopes) : [];
            const formatPermission = (permission: string) => {
              const hint = TEAMS_GRAPH_PERMISSION_HINTS[permission];
              return hint ? `${permission} (${hint})` : permission;
            };
            if (!graph.ok) {
              lines.push({ text: `Graph: ${graph.error ?? "failed"}`, tone: "error" });
            } else if (roles.length > 0 || scopes.length > 0) {
              if (roles.length > 0) {
                lines.push({ text: `Graph roles: ${roles.map(formatPermission).join(", ")}` });
              }
              if (scopes.length > 0) {
                lines.push({ text: `Graph scopes: ${scopes.map(formatPermission).join(", ")}` });
              }
            } else if (graph.ok) {
              lines.push({ text: "Graph: ok" });
            }
          }
          return lines;
        },
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            port: runtime?.port ?? null,
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const { monitorMSTeamsProvider } = await import("./index.js");
          const account = resolveMSTeamsAccount({
            cfg: ctx.cfg,
            accountId: ctx.accountId,
          });
          const port = account.config.webhook?.port ?? 3978;
          const statusSink = createAccountStatusSink({
            accountId: ctx.accountId,
            setStatus: ctx.setStatus,
          });
          statusSink({ port });
          ctx.log?.info(`starting provider account ${ctx.accountId} (port ${port})`);
          return monitorMSTeamsProvider({
            cfg: ctx.cfg,
            accountId: ctx.accountId,
            msteamsCfg: account.config,
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
            statusSink,
          });
        },
      },
    },
    security: {
      collectWarnings: ({ cfg, accountId }) => collectMSTeamsSecurityFindings({ cfg, accountId }),
    },
    pairing: {
      text: {
        idLabel: "msteamsUserId",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^(msteams|user):/i),
        notify: async ({ cfg, accountId, id, message }) => {
          const { sendMessageMSTeams } = await loadMSTeamsChannelRuntime();
          await sendMessageMSTeams({
            cfg,
            accountId,
            to: id,
            text: message,
          });
        },
      },
    },
    threading: {
      matchesToolContextTarget: ({ target, toolContext }) =>
        msteamsContextTargetsMatch(target, toolContext),
      buildToolContext: ({ context, hasRepliedRef }) => {
        const nativeChannelId = context.NativeChannelId?.trim();
        const hasChannelRoute = Boolean(nativeChannelId && nativeChannelId.includes("/"));
        const isChannel = context.ChatType === "channel";
        const messageThreadId =
          context.MessageThreadId != null
            ? normalizeOptionalString(String(context.MessageThreadId))
            : undefined;
        // Prefer MessageThreadId (root). ReplyToId fallback is channel-only — DM/group
        // quote replies must not inherit ambient thread metadata for dedupe.
        const currentThreadTs =
          messageThreadId ?? (isChannel ? normalizeOptionalString(context.ReplyToId) : undefined);
        return {
          currentChannelId: normalizeOptionalString(context.To),
          currentChatType:
            context.ChatType === "direct" ||
            context.ChatType === "group" ||
            context.ChatType === "channel"
              ? context.ChatType
              : undefined,
          currentMessagingTarget: hasChannelRoute ? nativeChannelId : undefined,
          currentGraphChannelId: hasChannelRoute ? nativeChannelId : undefined,
          currentThreadTs,
          ...(currentThreadTs ? { replyToMode: "all" as const } : {}),
          hasRepliedRef,
        };
      },
      resolveAutoThreadId: ({ cfg, to, toolContext }) =>
        resolveMSTeamsAutoThreadId({
          cfg: cfg.channels?.msteams,
          to,
          toolContext,
        }),
    },
    outbound: msteamsChannelOutbound,
  });
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
