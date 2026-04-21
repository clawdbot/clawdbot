import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { configureTaskRegistryRuntime } from "../../tasks/task-registry.store.js";
import type { MsgContext } from "../templating.js";
import { buildCommandContext } from "./commands-context.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";

export const baseCommandTestConfig = {
  commands: { text: true },
  channels: { whatsapp: { allowFrom: ["*"] } },
  session: { mainKey: "main", scope: "per-sender" },
} as OpenClawConfig;

export function buildCommandTestParams(
  commandBody: string,
  cfg: OpenClawConfig,
  ctxOverrides?: Partial<MsgContext>,
  options?: {
    workspaceDir?: string;
  },
): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "whatsapp",
    Surface: "whatsapp",
    ...ctxOverrides,
  } as MsgContext;

  const command = buildCommandContext({
    ctx,
    cfg,
    isGroup: false,
    triggerBodyNormalized: commandBody.trim(),
    commandAuthorized: true,
  });

  const params: HandleCommandsParams = {
    ctx,
    cfg,
    command,
    directives: parseInlineDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    workspaceDir: options?.workspaceDir ?? "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "whatsapp",
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
  return params;
}

export function configureInMemoryTaskRegistryStoreForTests(): void {
  configureTaskRegistryRuntime({
    store: {
      loadSnapshot: () => ({
        tasks: new Map(),
        deliveryStates: new Map(),
      }),
      saveSnapshot: () => {},
      upsertTaskWithDeliveryState: () => {},
      upsertTask: () => {},
      deleteTaskWithDeliveryState: () => {},
      deleteTask: () => {},
      upsertDeliveryState: () => {},
      deleteDeliveryState: () => {},
      close: () => {},
    },
  });
}

export function buildPluginsCommandParams(params: {
  commandBodyNormalized: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  gatewayClientScopes?: string[];
}): HandleCommandsParams {
  const commandBodyNormalized = params.commandBodyNormalized;
  return {
    cfg:
      params.cfg ??
      ({
        commands: {
          text: true,
          plugins: true,
        },
        plugins: { enabled: true },
      } as OpenClawConfig),
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      GatewayClientScopes: params.gatewayClientScopes ?? ["operator.write", "operator.pairing"],
      AccountId: undefined,
    },
    command: {
      commandBodyNormalized,
      rawBodyNormalized: commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "owner",
      channel: "whatsapp",
      channelId: "whatsapp",
      surface: "whatsapp",
      ownerList: [],
      from: "test-user",
      to: "test-bot",
    },
    sessionKey: "agent:main:whatsapp:direct:test-user",
    sessionEntry: {
      sessionId: "session-plugin-command",
      updatedAt: Date.now(),
    },
    workspaceDir: params.workspaceDir ?? "/tmp/plugins-workspace",
  } as unknown as HandleCommandsParams;
}
