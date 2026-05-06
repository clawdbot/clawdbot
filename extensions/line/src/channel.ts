import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveLineAccount } from "./accounts.js";
import { lineBindingsAdapter } from "./bindings.js";
import { type ChannelPlugin, type ResolvedLineAccount } from "./channel-api.js";
import { lineChannelPluginCommon } from "./channel-shared.js";
import { lineGatewayAdapter } from "./gateway.js";
import { resolveLineGroupRequireMention } from "./group-policy.js";
import { lineMessageAdapter, lineOutboundAdapter } from "./outbound.js";
import { hasLineDirectives, parseLineDirectives } from "./reply-payload-transform.js";
import { getLineRuntime } from "./runtime.js";
import { lineSetupAdapter } from "./setup-core.js";
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
    messaging: {
      targetPrefixes: ["line"],
      normalizeTarget: (target) => {
        const trimmed = target.trim();
        if (!trimmed) {
          return undefined;
        }
        return trimmed.replace(/^line:(group|room|user):/i, "").replace(/^line:/i, "");
      },
      resolveInboundConversation: lineBindingsAdapter.resolveInboundConversation,
      transformReplyPayload: ({ payload }) => {
        if (!payload.text || !hasLineDirectives(payload.text)) {
          return payload;
        }
        return parseLineDirectives(payload);
      },
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
    setup: lineSetupAdapter,
    status: lineStatusAdapter,
    gateway: lineGatewayAdapter,
    message: lineMessageAdapter,
    bindings: lineBindingsAdapter,
    conversationBindings: {
      defaultTopLevelPlacement: "current",
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
