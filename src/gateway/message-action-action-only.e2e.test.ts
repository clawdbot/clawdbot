// Proves action-only current-source sends across the real Gateway RPC boundary.
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type {
  ChannelMessageActionContext,
  ChannelMessageActionAdapter,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runMessageAction } from "../infra/outbound/message-action-runner.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  installGatewayTestHooks,
  setTestPluginRegistry,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const GATEWAY_TOKEN = "message-action-action-only-e2e-token";
const CURRENT_TARGET = "current-target";

function createActionOnlyPlugin(
  handleAction: NonNullable<ChannelMessageActionAdapter["handleAction"]>,
): ChannelPlugin {
  return {
    id: "actiononly",
    meta: {
      id: "actiononly",
      label: "Action Only",
      selectionLabel: "Action Only",
      docsPath: "/channels/actiononly",
      blurb: "Action-only Gateway proof fixture.",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ enabled: true }),
      isConfigured: () => true,
    },
    messaging: {
      targetResolver: {
        looksLikeId: () => true,
        resolveTarget: async ({ input }: { input: string }) => ({
          to: input,
          kind: "group" as const,
          source: "normalized" as const,
        }),
      },
    },
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
      supportsAction: ({ action }) => action === "send",
      resolveExecutionMode: ({ action }) => (action === "send" ? "gateway" : "local"),
      handleAction,
    },
  };
}

function sourceInput(cfg: OpenClawConfig, gatewayPort: number) {
  return {
    cfg,
    action: "send" as const,
    params: { message: "hello from Gateway proof" },
    toolContext: {
      currentChannelProvider: "actiononly",
      currentChannelId: CURRENT_TARGET,
      currentMessagingTarget: CURRENT_TARGET,
      currentChatType: "direct" as const,
    },
    sessionKey: `agent:main:actiononly:direct:${CURRENT_TARGET}`,
    sourceReplyDeliveryMode: "message_tool_only" as const,
    gateway: {
      url: `ws://127.0.0.1:${gatewayPort}`,
      token: GATEWAY_TOKEN,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientDisplayName: "message-action-action-only-proof",
      mode: GATEWAY_CLIENT_MODES.TEST,
    },
  };
}

describe("message.action action-only Gateway proof", () => {
  it("bypasses the private sink only when the configured plugin owns send", async () => {
    const gatewayTrace: Array<{
      action: string;
      gatewayBound: boolean;
      target: unknown;
    }> = [];
    const handleAction = vi.fn(async (ctx: ChannelMessageActionContext) => {
      gatewayTrace.push({
        action: ctx.action,
        gatewayBound: Boolean(getPluginRuntimeGatewayRequestScope()?.context),
        target: ctx.params.to ?? ctx.params.channelId,
      });
      return {
        content: [{ type: "text" as const, text: "plugin delivery" }],
        details: { handledBy: "actiononly", target: ctx.params.to ?? ctx.params.channelId },
      };
    });
    const plugin = createActionOnlyPlugin(handleAction);
    const cfg = { channels: { actiononly: { enabled: true } } } as OpenClawConfig;
    testState.channelsConfig = { actiononly: { enabled: true } };
    setTestPluginRegistry(createTestRegistry([{ pluginId: "actiononly", source: "test", plugin }]));

    await withGatewayServer(
      async ({ port }) => {
        const result = await runMessageAction(sourceInput(cfg, port));

        expect(result).toMatchObject({
          kind: "send",
          channel: "actiononly",
          to: CURRENT_TARGET,
          handledBy: "plugin",
        });
        expect(handleAction).toHaveBeenCalledOnce();
        expect(gatewayTrace).toEqual([
          { action: "send", gatewayBound: true, target: CURRENT_TARGET },
        ]);

        const disabledResult = await runMessageAction(sourceInput({} as OpenClawConfig, port));
        expect(disabledResult).toMatchObject({
          kind: "send",
          handledBy: "internal-source",
          channel: "webchat",
          to: "current-run",
        });
        expect(handleAction).toHaveBeenCalledOnce();
      },
      { serverOptions: { auth: { mode: "token", token: GATEWAY_TOKEN } } },
    );
  }, 30_000);
});
