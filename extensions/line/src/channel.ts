// Line plugin module implements channel behavior.
import {
  buildDmGroupAccountAllowlistAdapter,
  createFlatAllowlistOverrideResolver,
} from "openclaw/plugin-sdk/allowlist-config-edit";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveLineAccount } from "./accounts.js";
import { lineBindingsAdapter } from "./bindings.js";
import type { ChannelPlugin, ResolvedLineAccount } from "./channel-api.js";
import { lineChannelPluginCommon } from "./channel-shared.js";
import { lineConfigAdapter } from "./config-adapter.js";
import { lineGatewayAdapter } from "./gateway.js";
import { resolveLineGroupRequireMention } from "./group-policy.js";
import { inferLineTargetChatType, normalizeLineMessagingTarget } from "./messaging-target.js";
import { lineMessageAdapter, lineOutboundAdapter } from "./outbound.js";
import { lineMessageActions } from "./rich-messages.js";
import { getLineRuntime } from "./runtime.js";
import { lineSetupContract } from "./setup-core.js";
import { lineSetupWizard } from "./setup-surface.js";
import { lineStatusAdapter } from "./status.js";

const loadLineChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));

const lineSecurityAdapter = createRestrictSendersChannelSecurity<ResolvedLineAccount>({
  channelKey: "line",
  resolveDmPolicy: (account) => account.config.dmPolicy,
  resolveDmAllowFrom: (account) => account.config.allowFrom,
  resolveGroupPolicy: (account) => account.config.groupPolicy,
  surface: "LINE groups",
  openScope: "any member in groups",
  groupPolicyPath: "channels.line.groupPolicy",
  groupAllowFromPath: "channels.line.groupAllowFrom",
  mentionGated: false,
  findingTitle: "LINE security warning",
  policyPathSuffix: "dmPolicy",
  approveHint: "openclaw pairing approve line <code>",
  normalizeDmEntry: (raw) => raw.replace(/^line:(?:user:)?/i, ""),
});

export const linePlugin: ChannelPlugin<ResolvedLineAccount> = createChatChannelPlugin({
  base: {
    id: "line",
    ...lineChannelPluginCommon,
    setupWizard: lineSetupWizard,
    groups: {
      resolveRequireMention: resolveLineGroupRequireMention,
    },
    allowlist: buildDmGroupAccountAllowlistAdapter({
      channelId: "line",
      resolveAccount: ({ cfg, accountId }) =>
        resolveLineAccount({ cfg, accountId: accountId ?? undefined }),
      normalize: ({ cfg, accountId, values }) =>
        lineConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
      resolveDmAllowFrom: (account) => account.config.allowFrom,
      resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
      resolveDmPolicy: (account) => account.config.dmPolicy,
      resolveGroupPolicy: (account) => account.config.groupPolicy,
      resolveGroupOverrides: createFlatAllowlistOverrideResolver({
        resolveRecord: (account) => account.config.groups,
        label: (groupId) => groupId,
        resolveEntries: (groupCfg) => groupCfg?.allowFrom,
      }),
    }),
    messaging: {
      targetPrefixes: ["line"],
      normalizeTarget: normalizeLineMessagingTarget,
      inferTargetChatType: ({ to }) => inferLineTargetChatType(to),
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const peerId = normalizeLineMessagingTarget(target);
        const chatType = inferLineTargetChatType(target);
        if (!peerId || !chatType) {
          return null;
        }
        const isRoom = peerId.startsWith("R");
        return buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: "line",
          accountId,
          recipientSessionExact: true,
          peer: { kind: chatType, id: peerId },
          chatType,
          from:
            chatType === "direct"
              ? `line:${peerId}`
              : isRoom
                ? `line:room:${peerId}`
                : `line:group:${peerId}`,
          to: peerId,
        });
      },
      resolveInboundConversation: lineBindingsAdapter.resolveInboundConversation,
      targetResolver: {
        looksLikeId: (id) => {
          const trimmed = id?.trim();
          if (!trimmed) {
            return false;
          }
          return /^[UCR][a-f0-9]{32}$/i.test(trimmed) || /^line:/i.test(trimmed);
        },
        hint: "<userId|groupId|roomId>",
      },
    },
    directory: createEmptyChannelDirectoryAdapter(),
    setupContract: lineSetupContract,
    status: lineStatusAdapter,
    gateway: lineGatewayAdapter,
    message: lineMessageAdapter,
    actions: lineMessageActions,
    bindings: lineBindingsAdapter,
    conversationBindings: {
      defaultTopLevelPlacement: "current",
    },
    agentPrompt: {
      messageToolHints: () => [
        "",
        "### LINE structured output",
        "Use `presentation.blocks` for buttons, yes/no choices, and selectable options; LINE maps them to Flex controls or quick replies.",
        "Use `channelData.line.location` for a location pin and `channelData.line.card` for one LINE-specific card. Supported card types are `media_player`, `event`, `agenda`, `device`, and `appletv_remote`.",
        "Send rich output with the structured message fields. Double-bracket marker text has no special meaning.",
      ],
    },
  },
  pairing: {
    text: {
      idLabel: "lineUserId",
      message: "OpenClaw: your access has been approved.",
      normalizeAllowEntry: createPairingPrefixStripper(/^line:(?:user:)?/i),
      notify: async ({ cfg, id, message }) => {
        const account = (getLineRuntime().channel.line?.resolveLineAccount ?? resolveLineAccount)({
          cfg,
        });
        if (!account.channelAccessToken) {
          throw new Error("LINE channel access token not configured");
        }
        const pushMessageLine =
          getLineRuntime().channel.line?.pushMessageLine ??
          (await loadLineChannelRuntime()).pushMessageLine;
        await pushMessageLine(id, message, {
          cfg,
          accountId: account.accountId,
          channelAccessToken: account.channelAccessToken,
        });
      },
    },
  },
  security: lineSecurityAdapter,
  outbound: lineOutboundAdapter,
});
