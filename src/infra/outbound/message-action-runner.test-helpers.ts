// Shared runner-facade test harness. These mocks isolate message-action routing,
// execution, and send coordination from real channel and gateway runtimes.
import { vi } from "vitest";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
} from "../../interactive/payload.js";
import { extractToolPayload } from "../../plugin-sdk/tool-payload.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

type ChannelActionHandler = NonNullable<NonNullable<ChannelPlugin["actions"]>["handleAction"]>;

export const messageActionRunnerMocks = {
  resolveOutboundChannelPlugin: vi.fn(),
  executeSendAction: vi.fn(),
  executePollAction: vi.fn(),
  hasCorePresentationDelivery: vi.fn(),
  materializeMessagePresentationFallback: vi.fn(),
  callGateway: vi.fn(),
  callGatewayLeastPrivilege: vi.fn(),
  isGatewayTransportError: vi.fn(),
  randomIdempotencyKey: vi.fn(() => "idem-gateway-action"),
  maybeApplyTtsToPayload: vi.fn(async (params: { payload: unknown }) => params.payload),
  prepareOutboundMirrorRoute: vi.fn(),
  beginTerminalSourceReplyDelivery: vi.fn(),
  cancelTerminalSourceReplyDelivery: vi.fn(),
  isCurrentSourceReplyActionName: vi.fn(() => false),
  isDeliveredCurrentSourceReply: vi.fn(() => false),
  isDeliveredCurrentSourceReplyAction: vi.fn(() => false),
  reconcileTerminalSourceReplyDelivery: vi.fn(),
  loadWebMedia: vi.fn<typeof import("../../media/web-media.js").loadWebMedia>(),
};

vi.mock("./channel-resolution.js", () => ({
  normalizeDeliverableOutboundChannel: (value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() || undefined : undefined,
  resolveOutboundChannelPlugin: messageActionRunnerMocks.resolveOutboundChannelPlugin,
  resetOutboundChannelResolutionStateForTest: vi.fn(),
}));

vi.mock("./outbound-send-service.js", () => ({
  executeSendAction: messageActionRunnerMocks.executeSendAction,
  executePollAction: messageActionRunnerMocks.executePollAction,
  hasCorePresentationDelivery: messageActionRunnerMocks.hasCorePresentationDelivery,
  materializeMessagePresentationFallback:
    messageActionRunnerMocks.materializeMessagePresentationFallback,
}));

vi.mock("./message.gateway.runtime.js", () => ({
  callGateway: messageActionRunnerMocks.callGateway,
  callGatewayLeastPrivilege: messageActionRunnerMocks.callGatewayLeastPrivilege,
  isGatewayTransportError: messageActionRunnerMocks.isGatewayTransportError,
  randomIdempotencyKey: messageActionRunnerMocks.randomIdempotencyKey,
}));

vi.mock("./source-reply-mirror.js", () => ({
  beginTerminalSourceReplyDelivery: messageActionRunnerMocks.beginTerminalSourceReplyDelivery,
  cancelTerminalSourceReplyDelivery: messageActionRunnerMocks.cancelTerminalSourceReplyDelivery,
  isCurrentSourceReplyActionName: messageActionRunnerMocks.isCurrentSourceReplyActionName,
  isDeliveredCurrentSourceReply: messageActionRunnerMocks.isDeliveredCurrentSourceReply,
  isDeliveredCurrentSourceReplyAction: messageActionRunnerMocks.isDeliveredCurrentSourceReplyAction,
  reconcileTerminalSourceReplyDelivery:
    messageActionRunnerMocks.reconcileTerminalSourceReplyDelivery,
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: messageActionRunnerMocks.maybeApplyTtsToPayload,
}));

vi.mock("./outbound-session.js", () => ({
  ensureOutboundSessionEntry: vi.fn(async () => undefined),
  resolveOutboundSessionRoute: vi.fn(async () => null),
}));

vi.mock("../../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "actionhub"
      ? {
          actions: {
            messageActionTargetAliases: {
              pin: { aliases: ["messageId"] },
              unpin: { aliases: ["messageId"] },
              "list-pins": { aliases: ["chatId"] },
            },
          },
        }
      : undefined,
}));

vi.mock("./message-action-threading.js", async () => {
  const { createOutboundThreadingMock } =
    await import("./message-action-threading.test-helpers.js");
  const threading = createOutboundThreadingMock();
  messageActionRunnerMocks.prepareOutboundMirrorRoute.mockImplementation(
    threading.prepareOutboundMirrorRoute,
  );
  return {
    ...threading,
    prepareOutboundMirrorRoute: messageActionRunnerMocks.prepareOutboundMirrorRoute,
  };
});

vi.mock("../../media/web-media.js", () => ({
  loadWebMedia: messageActionRunnerMocks.loadWebMedia,
}));

type RunMessageAction = typeof import("./message-action-runner.js").runMessageAction;

export const runMessageAction: RunMessageAction = async (...args) =>
  (await import("./message-action-runner.js")).runMessageAction(...args);

export function setMessageActionTestPlugin(plugin: unknown, pluginId: string, origin?: "bundled") {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId, source: "test", ...(origin ? { origin } : {}), plugin }]),
  );
}

export function createAlwaysConfiguredPluginConfig(
  account: Record<string, unknown> = { enabled: true },
) {
  return {
    listAccountIds: () => ["default"],
    resolveAccount: () => account,
    isConfigured: () => true,
  };
}

export function createGatewayActionPlugin(params: {
  pluginId: string;
  label: string;
  blurb: string;
  actions: ChannelMessageActionName[];
  gatewayActions?: ChannelMessageActionName[];
  capabilities?: ChannelPlugin["capabilities"];
  messaging?: ChannelPlugin["messaging"];
  threading?: ChannelPlugin["threading"];
  handleAction: ChannelActionHandler;
}): ChannelPlugin {
  const actions = new Set(params.actions);
  const gatewayActions = new Set(params.gatewayActions ?? params.actions);
  return {
    id: params.pluginId,
    meta: {
      id: params.pluginId,
      label: params.label,
      selectionLabel: params.label,
      docsPath: `/channels/${params.pluginId}`,
      blurb: params.blurb,
    },
    capabilities: params.capabilities ?? { chatTypes: ["direct"] },
    config: createAlwaysConfiguredPluginConfig(),
    messaging: params.messaging,
    threading: params.threading,
    actions: {
      describeMessageTool: () => ({ actions: params.actions }),
      supportsAction: ({ action }) => actions.has(action),
      resolveExecutionMode: ({ action }) => (gatewayActions.has(action) ? "gateway" : "local"),
      handleAction: params.handleAction,
    },
  };
}

export function createPollForwardingPlugin(params: {
  pluginId: string;
  label: string;
  blurb: string;
  handleAction: ChannelActionHandler;
}): ChannelPlugin {
  return {
    id: params.pluginId,
    meta: {
      id: params.pluginId,
      label: params.label,
      selectionLabel: params.label,
      docsPath: `/channels/${params.pluginId}`,
      blurb: params.blurb,
    },
    capabilities: { chatTypes: ["direct"] },
    config: createAlwaysConfiguredPluginConfig(),
    messaging: {
      targetResolver: {
        looksLikeId: () => true,
      },
    },
    actions: {
      describeMessageTool: () => ({ actions: ["poll"] }),
      supportsAction: ({ action }) => action === "poll",
      handleAction: params.handleAction,
    },
  };
}

async function executePluginAction(params: {
  action: "send" | "poll";
  ctx: Pick<
    ChannelMessageActionContext,
    | "channel"
    | "cfg"
    | "params"
    | "mediaAccess"
    | "accountId"
    | "gateway"
    | "toolContext"
    | "inboundEventKind"
  > & {
    dryRun: boolean;
    agentId?: string;
  };
}) {
  const handled = await dispatchChannelMessageAction({
    channel: params.ctx.channel,
    action: params.action,
    cfg: params.ctx.cfg,
    params: params.ctx.params,
    mediaAccess: params.ctx.mediaAccess,
    mediaLocalRoots: params.ctx.mediaAccess?.localRoots ?? [],
    mediaReadFile:
      typeof params.ctx.mediaAccess?.readFile === "function"
        ? params.ctx.mediaAccess.readFile
        : undefined,
    accountId: params.ctx.accountId ?? undefined,
    gateway: params.ctx.gateway,
    toolContext: params.ctx.toolContext,
    inboundEventKind: params.ctx.inboundEventKind,
    dryRun: params.ctx.dryRun,
    agentId: params.ctx.agentId,
  });
  if (!handled) {
    throw new Error(`expected plugin to handle ${params.action}`);
  }
  return {
    handledBy: "plugin" as const,
    payload: extractToolPayload(handled),
    toolResult: handled,
  };
}

export function resetMessageActionRunnerMocks() {
  const mocks = messageActionRunnerMocks;
  mocks.resolveOutboundChannelPlugin.mockReset();
  mocks.resolveOutboundChannelPlugin.mockImplementation(
    ({ channel }: { channel: string }) =>
      getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
  );
  mocks.executeSendAction.mockReset();
  mocks.executeSendAction.mockImplementation(
    async ({ ctx }: { ctx: Parameters<typeof executePluginAction>[0]["ctx"] }) =>
      await executePluginAction({ action: "send", ctx }),
  );
  mocks.executePollAction.mockReset();
  mocks.executePollAction.mockImplementation(
    async ({ ctx }: { ctx: Parameters<typeof executePluginAction>[0]["ctx"] }) =>
      await executePluginAction({ action: "poll", ctx }),
  );
  mocks.hasCorePresentationDelivery.mockReset();
  mocks.hasCorePresentationDelivery.mockImplementation(
    (outbound?: { sendPayload?: unknown; sendText?: unknown; sendFormattedText?: unknown }) =>
      Boolean(outbound?.sendPayload || outbound?.sendText || outbound?.sendFormattedText),
  );
  mocks.materializeMessagePresentationFallback.mockReset();
  mocks.materializeMessagePresentationFallback.mockImplementation(
    (params: { payload: { presentation?: unknown; text?: string }; text?: string }) => {
      const presentation = normalizeMessagePresentation(params.payload.presentation);
      const text = (params.text ?? params.payload.text ?? "").trim();
      if (!presentation) {
        return text;
      }
      const fallback = renderMessagePresentationFallbackText({ presentation });
      return !fallback || text.includes(fallback)
        ? text
        : [text, fallback].filter(Boolean).join("\n\n");
    },
  );
  mocks.callGateway.mockReset();
  mocks.callGatewayLeastPrivilege.mockReset();
  mocks.isGatewayTransportError.mockReset();
  mocks.isGatewayTransportError.mockImplementation(
    (value: unknown) => value instanceof Error && (value as { kind?: unknown }).kind === "timeout",
  );
  mocks.randomIdempotencyKey.mockClear();
  mocks.maybeApplyTtsToPayload.mockReset();
  mocks.maybeApplyTtsToPayload.mockImplementation(
    async (params: { payload: unknown }) => params.payload,
  );
  mocks.prepareOutboundMirrorRoute.mockClear();
  mocks.beginTerminalSourceReplyDelivery.mockReset();
  mocks.cancelTerminalSourceReplyDelivery.mockReset();
  mocks.reconcileTerminalSourceReplyDelivery.mockReset();
}

let actualLoadWebMedia: typeof import("../../media/web-media.js").loadWebMedia | undefined;

export async function resetMessageActionMediaMocks() {
  actualLoadWebMedia ??= (
    await vi.importActual<typeof import("../../media/web-media.js")>("../../media/web-media.js")
  ).loadWebMedia;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  const mocks = messageActionRunnerMocks;
  mocks.resolveOutboundChannelPlugin.mockReset();
  mocks.resolveOutboundChannelPlugin.mockImplementation(
    ({ channel }: { channel: string }) =>
      getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
  );
  mocks.executeSendAction.mockReset();
  mocks.executeSendAction.mockImplementation(
    async ({
      ctx,
      to,
      message,
      mediaUrl,
      mediaUrls,
    }: {
      ctx: { channel: string; dryRun: boolean };
      to: string;
      message: string;
      mediaUrl?: string;
      mediaUrls?: string[];
    }) => ({
      handledBy: "core" as const,
      payload: {
        channel: ctx.channel,
        to,
        message,
        mediaUrl,
        mediaUrls,
        dryRun: ctx.dryRun,
      },
      sendResult: {
        channel: ctx.channel,
        messageId: "msg-test",
        ...(mediaUrl ? { mediaUrl } : {}),
        ...(mediaUrls ? { mediaUrls } : {}),
      },
    }),
  );
  mocks.executePollAction.mockReset();
  mocks.executePollAction.mockImplementation(async () => {
    throw new Error("executePollAction should not run in media tests");
  });
  mocks.loadWebMedia.mockReset();
  mocks.loadWebMedia.mockImplementation(actualLoadWebMedia);
}

export const pollerConfig = {
  channels: {
    poller: {
      botToken: "poller-test",
    },
  },
} as OpenClawConfig;

export const pollerTestPlugin: ChannelPlugin = {
  id: "poller",
  meta: {
    id: "poller",
    label: "Poller",
    selectionLabel: "Poller",
    docsPath: "/channels/poller",
    blurb: "Poller test plugin.",
  },
  capabilities: { chatTypes: ["direct", "group"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ botToken: "poller-test" }),
    isConfigured: () => true,
  },
  outbound: {
    deliveryMode: "gateway",
    sendPoll: async () => ({
      messageId: "poll-test",
    }),
  },
  messaging: {
    targetResolver: {
      looksLikeId: () => true,
      resolveTarget: async ({ normalized }) => ({
        to: normalized,
        kind: "user",
        source: "normalized",
      }),
    },
  },
  threading: {
    resolveAutoThreadId: ({ toolContext, to, replyToId }) => {
      if (replyToId) {
        return undefined;
      }
      if (toolContext?.currentChannelId !== to) {
        return undefined;
      }
      return toolContext.currentThreadTs;
    },
  },
};

export async function runPollAction(params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  toolContext?: Record<string, unknown>;
  inboundEventKind?: "user_request" | "room_event";
}) {
  await runMessageAction({
    cfg: params.cfg,
    action: "poll",
    params: params.actionParams as never,
    toolContext: params.toolContext as never,
    inboundEventKind: params.inboundEventKind,
  });
  const call = messageActionRunnerMocks.executePollAction.mock.calls[0]?.[0] as
    | {
        resolveCorePoll?: () => {
          durationHours?: number;
          maxSelections?: number;
          threadId?: string;
        };
        ctx?: {
          plugin?: ChannelPlugin;
          inboundEventKind?: string;
          idempotencyKey?: string;
          params?: Record<string, unknown>;
        };
      }
    | undefined;
  if (!call) {
    throw new Error("expected executePollAction call");
  }
  return {
    ...call.resolveCorePoll?.(),
    ctx: call.ctx,
  };
}

export function resetMessageActionPollMocks() {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "poller", source: "test", plugin: pollerTestPlugin }]),
  );
  const mocks = messageActionRunnerMocks;
  mocks.resolveOutboundChannelPlugin.mockReset();
  mocks.resolveOutboundChannelPlugin.mockImplementation(
    ({ channel }: { channel: string }) =>
      getActivePluginRegistry()?.channels.find((entry) => entry?.plugin?.id === channel)?.plugin,
  );
  mocks.executeSendAction.mockReset();
  mocks.executeSendAction.mockImplementation(async () => {
    throw new Error("executeSendAction should not run in poll tests");
  });
  mocks.executePollAction.mockReset();
  mocks.executePollAction.mockImplementation(async (input) => ({
    handledBy: "core",
    payload: { ok: true, corePoll: input.resolveCorePoll() },
    pollResult: { ok: true },
  }));
}

export function clearMessageActionPollMocks() {
  setActivePluginRegistry(createTestRegistry([]));
  messageActionRunnerMocks.executePollAction.mockReset();
}
