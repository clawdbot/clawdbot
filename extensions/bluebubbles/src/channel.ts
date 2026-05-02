import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createAccountStatusSink } from "openclaw/plugin-sdk/channel-lifecycle";
import {
  createOpenGroupPolicyRestrictSendersWarningCollector,
  projectAccountWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { buildProbeChannelStatusSummary } from "openclaw/plugin-sdk/channel-status";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  type ResolvedBlueBubblesAccount,
  resolveBlueBubblesEffectiveAllowPrivateNetwork,
} from "./accounts.js";
import { bluebubblesMessageActions } from "./actions.js";
import {
  bluebubblesCapabilities,
  bluebubblesConfigAdapter,
  bluebubblesConfigSchema,
  bluebubblesReload,
  describeBlueBubblesAccount,
  bluebubblesMeta as meta,
} from "./channel-shared.js";
import type { BlueBubblesProbe } from "./channel.runtime.js";
import { createBlueBubblesConversationBindingManager } from "./conversation-bindings.js";
import {
  matchBlueBubblesAcpConversation,
  normalizeBlueBubblesAcpConversationId,
  resolveBlueBubblesConversationIdFromTarget,
} from "./conversation-id.js";
import { bluebubblesDoctor } from "./doctor.js";
import {
  resolveBlueBubblesGroupRequireMention,
  resolveBlueBubblesGroupToolPolicy,
} from "./group-policy.js";
import { createBlueBubblesPairingText } from "./pairing.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "./runtime-api.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { resolveBlueBubblesOutboundSessionRoute } from "./session-route.js";
import { blueBubblesSetupAdapter } from "./setup-core.js";
import { blueBubblesSetupWizard } from "./setup-surface.js";
import { collectBlueBubblesStatusIssues } from "./status-issues.js";
import {
  buildBlueBubblesChatContextFromTarget,
  extractHandleFromChatGuid,
  inferBlueBubblesTargetChatType,
  looksLikeBlueBubblesExplicitTargetId,
  looksLikeBlueBubblesTargetId,
  normalizeBlueBubblesHandle,
  normalizeBlueBubblesMessagingTarget,
  parseBlueBubblesTarget,
} from "./targets.js";

const loadBlueBubblesChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "blueBubblesChannelRuntime",
);

const resolveBlueBubblesDmPolicy = createScopedDmSecurityResolver<ResolvedBlueBubblesAccount>({
  channelKey: "bluebubbles",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  normalizeEntry: (raw) => normalizeBlueBubblesHandle(raw.replace(/^bluebubbles:/i, "")),
});

const collectBlueBubblesSecurityWarnings =
  createOpenGroupPolicyRestrictSendersWarningCollector<ResolvedBlueBubblesAccount>({
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    defaultGroupPolicy: "allowlist",
    surface: "BlueBubbles groups",
    openScope: "any member",
    groupPolicyPath: "channels.bluebubbles.groupPolicy",
    groupAllowFromPath: "channels.bluebubbles.groupAllowFrom",
    mentionGated: false,
  });

export const bluebubblesPlugin: ChannelPlugin<ResolvedBlueBubblesAccount, BlueBubblesProbe> =
  createChatChannelPlugin<ResolvedBlueBubblesAccount, BlueBubblesProbe>({
    base: {
      id: "bluebubbles",
      meta,
      capabilities: bluebubblesCapabilities,
      groups: {
        resolveRequireMention: resolveBlueBubblesGroupRequireMention,
        resolveToolPolicy: resolveBlueBubblesGroupToolPolicy,
      },
      reload: bluebubblesReload,
      configSchema: bluebubblesConfigSchema,
      setupWizard: blueBubblesSetupWizard,
      config: {
        ...bluebubblesConfigAdapter,
        isConfigured: (account) => account.configured,
        describeAccount: (account): ChannelAccountSnapshot => describeBlueBubblesAccount(account),
      },
      doctor: bluebubblesDoctor,
      conversationBindings: {
        supportsCurrentConversationBinding: true,
        createManager: ({ cfg, accountId }) =>
          createBlueBubblesConversationBindingManager({
            cfg,
            accountId: accountId ?? undefined,
          }),
      },
      actions: bluebubblesMessageActions,
      secrets: {
        secretTargetRegistryEntries,
        collectRuntimeConfigAssignments,
      },
      bindings: {
        compileConfiguredBinding: ({ conversationId }) =>
          normalizeBlueBubblesAcpConversationId(conversationId),
        matchInboundConversation: ({ compiledBinding, conversationId }) =>
          matchBlueBubblesAcpConversation({
            bindingConversationId: compiledBinding.conversationId,
            conversationId,
          }),
        resolveCommandConversation: ({ originatingTo, commandTo, fallbackTo }) => {
          const conversationId =
            resolveBlueBubblesConversationIdFromTarget(originatingTo ?? "") ??
            resolveBlueBubblesConversationIdFromTarget(commandTo ?? "") ??
            resolveBlueBubblesConversationIdFromTarget(fallbackTo ?? "");
          return conversationId ? { conversationId } : null;
        },
      },
      messaging: {
        targetPrefixes: ["bluebubbles"],
        normalizeTarget: normalizeBlueBubblesMessagingTarget,
        inferTargetChatType: ({ to }) => inferBlueBubblesTargetChatType(to),
        resolveOutboundSessionRoute: (params) => resolveBlueBubblesOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: looksLikeBlueBubblesExplicitTargetId,
          hint: "<handle|chat_guid:GUID|chat_id:ID|chat_identifier:ID>",
          resolveTarget: async ({ normalized }) => {
            const to = normalizeOptionalString(normalized);
            if (!to) {
              return null;
            }
            const chatType = inferBlueBubblesTargetChatType(to);
            if (!chatType) {
              return null;
            }
            return {
              to,
              kind: chatType === "direct" ? "user" : "group",
              source: "normalized" as const,
            };
          },
        },
        formatTargetDisplay: ({ target, display }) => {
          const shouldParseDisplay = (value: string): boolean => {
            if (looksLikeBlueBubblesTargetId(value)) {
              return true;
            }
            return /^(bluebubbles:|chat_guid:|chat_id:|chat_identifier:)/i.test(value);
          };

          // Helper to extract a clean handle from any BlueBubbles target format
          const extractCleanDisplay = (value: string | undefined): string | null => {
            const trimmed = normalizeOptionalString(value);
            if (!trimmed) {
              return null;
            }
            try {
              const parsed = parseBlueBubblesTarget(trimmed);
              if (parsed.kind === "chat_guid") {
                const handle = extractHandleFromChatGuid(parsed.chatGuid);
                if (handle) {
                  return handle;
                }
              }
              if (parsed.kind === "handle") {
                return normalizeBlueBubblesHandle(parsed.to);
              }
            } catch {
              // Fall through
            }
            // Strip common prefixes and try raw extraction
            const stripped = trimmed
              .replace(/^bluebubbles:/i, "")
              .replace(/^chat_guid:/i, "")
              .replace(/^chat_id:/i, "")
              .replace(/^chat_identifier:/i, "");
            const handle = extractHandleFromChatGuid(stripped);
            if (handle) {
              return handle;
            }
            // Don't return raw chat_guid formats - they contain internal routing info
            if (stripped.includes(";-;") || stripped.includes(";+;")) {
              return null;
            }
            return stripped;
          };

          // Try to get a clean display from the display parameter first
          const trimmedDisplay = normalizeOptionalString(display);
          if (trimmedDisplay) {
            if (!shouldParseDisplay(trimmedDisplay)) {
              return trimmedDisplay;
            }
            const cleanDisplay = extractCleanDisplay(trimmedDisplay);
            if (cleanDisplay) {
              return cleanDisplay;
            }
          }

          // Fall back to extracting from target
          const cleanTarget = extractCleanDisplay(target);
          if (cleanTarget) {
            return cleanTarget;
          }

          // Last resort: return display or target as-is
          return normalizeOptionalString(display) || normalizeOptionalString(target) || "";
        },
      },
      setup: blueBubblesSetupAdapter,
      status: createComputedAccountStatusAdapter<ResolvedBlueBubblesAccount, BlueBubblesProbe>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        collectStatusIssues: collectBlueBubblesStatusIssues,
        buildChannelSummary: ({ snapshot }) =>
          buildProbeChannelStatusSummary(snapshot, { baseUrl: snapshot.baseUrl ?? null }),
        probeAccount: async ({ account, timeoutMs }) =>
          (await loadBlueBubblesChannelRuntime()).probeBlueBubbles({
            baseUrl: account.baseUrl,
            password: account.config.password ?? null,
            timeoutMs,
            allowPrivateNetwork: resolveBlueBubblesEffectiveAllowPrivateNetwork({
              baseUrl: account.baseUrl,
              config: account.config,
            }),
          }),
        resolveAccountSnapshot: ({ account, runtime, probe }) => {
          const running = runtime?.running ?? false;
          const probeOk = probe?.ok;
          return {
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: account.configured,
            extra: {
              baseUrl: account.baseUrl,
              connected: probeOk ?? running,
            },
          };
        },
      }),
      gateway: {
        startAccount: async (ctx) => {
          const runtime = await loadBlueBubblesChannelRuntime();
          const account = ctx.account;
          const conversationBindings = createBlueBubblesConversationBindingManager({
            cfg: ctx.cfg,
            accountId: ctx.accountId,
          });
          const webhookPath = runtime.resolveWebhookPathFromConfig(account.config);
          const statusSink = createAccountStatusSink({
            accountId: ctx.accountId,
            setStatus: ctx.setStatus,
          });
          statusSink({
            baseUrl: account.baseUrl,
          });
          ctx.log?.info(`[${account.accountId}] starting provider (webhook=${webhookPath})`);
          try {
            return await runtime.monitorBlueBubblesProvider({
              account,
              config: ctx.cfg,
              runtime: ctx.runtime,
              abortSignal: ctx.abortSignal,
              statusSink,
              webhookPath,
            });
          } finally {
            conversationBindings.stop();
          }
        },
      },
    },
    security: {
      resolveDmPolicy: resolveBlueBubblesDmPolicy,
      collectWarnings: projectAccountWarningCollector<
        ResolvedBlueBubblesAccount,
        { account: ResolvedBlueBubblesAccount }
      >(collectBlueBubblesSecurityWarnings),
    },
    threading: {
      buildToolContext: ({ context, hasRepliedRef }) => ({
        currentChannelId: normalizeOptionalString(context.To),
        currentThreadTs: context.ReplyToIdFull ?? context.ReplyToId,
        hasRepliedRef,
      }),
    },
    pairing: {
      text: createBlueBubblesPairingText(async (id, message, params) => {
        await (await loadBlueBubblesChannelRuntime()).sendMessageBlueBubbles(id, message, params);
      }),
    },
    outbound: {
      base: {
        deliveryMode: "direct",
        textChunkLimit: 4000,
        resolveTarget: ({ to }) => {
          const trimmed = normalizeOptionalString(to);
          if (!trimmed) {
            return {
              ok: false,
              error: new Error("Delivering to BlueBubbles requires --to <handle|chat_guid:GUID>"),
            };
          }
          return { ok: true, to: trimmed };
        },
      },
      attachedResults: {
        channel: "bluebubbles",
        sendText: async ({ cfg, to, text, accountId, replyToId }) => {
          const runtime = await loadBlueBubblesChannelRuntime();
          const rawReplyToId = normalizeOptionalString(replyToId) ?? "";
          const replyToMessageGuid = rawReplyToId
            ? runtime.resolveBlueBubblesMessageId(rawReplyToId, {
                requireKnownShortId: true,
                chatContext: buildBlueBubblesChatContextFromTarget(to),
              })
            : "";
          return await runtime.sendMessageBlueBubbles(to, text, {
            cfg: cfg,
            accountId: accountId ?? undefined,
            replyToMessageGuid: replyToMessageGuid || undefined,
          });
        },
        sendMedia: async (ctx) => {
          const runtime = await loadBlueBubblesChannelRuntime();
          const { cfg, to, text, mediaUrl, accountId, replyToId, audioAsVoice } = ctx;
          const { mediaPath, mediaBuffer, contentType, filename, caption } = ctx as {
            mediaPath?: string;
            mediaBuffer?: Uint8Array;
            contentType?: string;
            filename?: string;
            caption?: string;
          };
          return await runtime.sendBlueBubblesMedia({
            cfg: cfg,
            to,
            mediaUrl,
            mediaPath,
            mediaBuffer,
            contentType,
            filename,
            caption: caption ?? text ?? undefined,
            replyToId: replyToId ?? null,
            accountId: accountId ?? undefined,
            asVoice: audioAsVoice === true,
          });
        },
      },
    },
  });
