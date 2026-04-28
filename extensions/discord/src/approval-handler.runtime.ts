import {
  Button,
  Row,
  Separator,
  TextDisplay,
  serializePayload,
  type MessagePayloadObject,
  type TopLevelComponents,
} from "@buape/carbon";
import { ButtonStyle, Routes } from "discord-api-types/v10";
import type {
  ChannelApprovalCapabilityHandlerContext,
  ExecApprovalExpiredView,
  ExecApprovalPendingView,
  ExecApprovalResolvedView,
  PendingApprovalView,
  PluginApprovalExpiredView,
  PluginApprovalPendingView,
  PluginApprovalResolvedView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ExecApprovalActionDescriptor } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { ExecApprovalDecision } from "openclaw/plugin-sdk/approval-runtime";
import type { DiscordExecApprovalConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { logDebug, logError, normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { shouldHandleDiscordApprovalRequest } from "./approval-shared.js";
import { isDiscordExecApprovalClientEnabled } from "./exec-approvals.js";
import { createDiscordClient, stripUndefinedFields } from "./send.shared.js";
import { DiscordUiContainer } from "./ui.js";

type PendingApproval = {
  discordMessageId: string;
  discordChannelId: string;
};
type DiscordPendingDelivery = {
  body: ReturnType<typeof stripUndefinedFields>;
};
type PreparedDeliveryTarget = {
  discordChannelId: string;
  recipientUserId?: string;
};

export type DiscordApprovalHandlerContext = {
  token: string;
  config: DiscordExecApprovalConfig;
};

function resolveHandlerContext(params: ChannelApprovalCapabilityHandlerContext): {
  accountId: string;
  context: DiscordApprovalHandlerContext;
} | null {
  const context = params.context as DiscordApprovalHandlerContext | undefined;
  const accountId = normalizeOptionalString(params.accountId) ?? "";
  if (!context?.token || !accountId) {
    return null;
  }
  return { accountId, context };
}

class ExecApprovalContainer extends DiscordUiContainer {
  constructor(params: {
    cfg: OpenClawConfig;
    accountId: string;
    title: string;
    description?: string;
    commandPreview: string;
    commandSecondaryPreview?: string | null;
    metadataLines?: string[];
    actionRow?: Row<Button>;
    footer?: string;
    accentColor?: string;
  }) {
    const components: Array<TextDisplay | Separator | Row<Button>> = [
      new TextDisplay(`## ${params.title}`),
    ];
    if (params.description) {
      components.push(new TextDisplay(params.description));
    }
    components.push(new Separator({ divider: true, spacing: "small" }));
    components.push(new TextDisplay(`### Command\n\`\`\`\n${params.commandPreview}\n\`\`\``));
    if (params.commandSecondaryPreview) {
      components.push(
        new TextDisplay(`### Shell Preview\n\`\`\`\n${params.commandSecondaryPreview}\n\`\`\``),
      );
    }
    if (params.metadataLines?.length) {
      components.push(new TextDisplay(params.metadataLines.join("\n")));
    }
    if (params.actionRow) {
      components.push(params.actionRow);
    }
    if (params.footer) {
      components.push(new Separator({ divider: false, spacing: "small" }));
      components.push(new TextDisplay(`-# ${params.footer}`));
    }
    super({
      cfg: params.cfg,
      accountId: params.accountId,
      components,
      accentColor: params.accentColor,
    });
  }
}

class ExecApprovalActionButton extends Button {
  customId: string;
  label: string;
  style: ButtonStyle;

  constructor(params: { approvalId: string; descriptor: ExecApprovalActionDescriptor }) {
    super();
    this.customId = buildExecApprovalCustomId(params.approvalId, params.descriptor.decision);
    this.label = params.descriptor.label;
    this.style =
      params.descriptor.style === "success"
        ? ButtonStyle.Success
        : params.descriptor.style === "primary"
          ? ButtonStyle.Primary
          : params.descriptor.style === "danger"
            ? ButtonStyle.Danger
            : ButtonStyle.Secondary;
  }
}

class ExecApprovalActionRow extends Row<Button> {
  constructor(params: { approvalId: string; actions: readonly ExecApprovalActionDescriptor[] }) {
    super(
      params.actions.map(
        (descriptor) => new ExecApprovalActionButton({ approvalId: params.approvalId, descriptor }),
      ),
    );
  }
}

function createApprovalActionRow(view: PendingApprovalView): Row<Button> {
  return new ExecApprovalActionRow({
    approvalId: view.approvalId,
    actions: view.actions,
  });
}

function buildApprovalMetadataLines(
  metadata: readonly { label: string; value: string }[],
): string[] {
  return metadata.map((item) => `- ${item.label}: ${item.value}`);
}

function buildExecApprovalPayload(container: DiscordUiContainer): MessagePayloadObject {
  const components: TopLevelComponents[] = [container];
  return { components };
}

function formatCommandPreview(commandText: string, maxChars: number): string {
  const commandRaw =
    commandText.length > maxChars ? `${commandText.slice(0, maxChars)}...` : commandText;
  return commandRaw.replace(/`/g, "\u200b`");
}

function formatOptionalCommandPreview(
  commandText: string | null | undefined,
  maxChars: number,
): string | null {
  if (!commandText) {
    return null;
  }
  return formatCommandPreview(commandText, maxChars);
}

function resolveCommandPreviews(
  commandText: string,
  commandPreview: string | null | undefined,
  maxChars: number,
  secondaryMaxChars: number,
): { commandPreview: string; commandSecondaryPreview: string | null } {
  return {
    commandPreview: formatCommandPreview(commandText, maxChars),
    commandSecondaryPreview: formatOptionalCommandPreview(commandPreview, secondaryMaxChars),
  };
}

function createExecApprovalRequestContainer(params: {
  view: ExecApprovalPendingView;
  cfg: OpenClawConfig;
  accountId: string;
  actionRow?: Row<Button>;
}): ExecApprovalContainer {
  const { commandPreview, commandSecondaryPreview } = resolveCommandPreviews(
    params.view.commandText,
    params.view.commandPreview,
    1000,
    500,
  );
  const expiresAtSeconds = Math.max(0, Math.floor(params.view.expiresAtMs / 1000));

  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: "Exec Approval Required",
    description: "A command needs your approval.",
    commandPreview,
    commandSecondaryPreview,
    metadataLines: buildApprovalMetadataLines(params.view.metadata),
    actionRow: params.actionRow,
    footer: `Expires <t:${expiresAtSeconds}:R> · ID: ${params.view.approvalId}`,
    accentColor: "#FFA500",
  });
}

function createPluginApprovalRequestContainer(params: {
  view: PluginApprovalPendingView;
  cfg: OpenClawConfig;
  accountId: string;
  actionRow?: Row<Button>;
}): ExecApprovalContainer {
  const expiresAtSeconds = Math.max(0, Math.floor(params.view.expiresAtMs / 1000));
  const severity = params.view.severity;
  const accentColor =
    severity === "critical" ? "#ED4245" : severity === "info" ? "#5865F2" : "#FAA61A";
  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: "Plugin Approval Required",
    description: "A plugin action needs your approval.",
    commandPreview: formatCommandPreview(params.view.title, 700),
    commandSecondaryPreview: formatOptionalCommandPreview(params.view.description, 1000),
    metadataLines: buildApprovalMetadataLines(params.view.metadata),
    actionRow: params.actionRow,
    footer: `Expires <t:${expiresAtSeconds}:R> · ID: ${params.view.approvalId}`,
    accentColor,
  });
}

function createExecResolvedContainer(params: {
  view: ExecApprovalResolvedView;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  const { commandPreview, commandSecondaryPreview } = resolveCommandPreviews(
    params.view.commandText,
    params.view.commandPreview,
    500,
    300,
  );
  const decisionLabel =
    params.view.decision === "allow-once"
      ? "Allowed (once)"
      : params.view.decision === "allow-always"
        ? "Allowed (always)"
        : "Denied";
  const accentColor =
    params.view.decision === "deny"
      ? "#ED4245"
      : params.view.decision === "allow-always"
        ? "#5865F2"
        : "#57F287";

  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: `Exec Approval: ${decisionLabel}`,
    description: params.view.resolvedBy ? `Resolved by ${params.view.resolvedBy}` : "Resolved",
    commandPreview,
    commandSecondaryPreview,
    metadataLines: buildApprovalMetadataLines(params.view.metadata),
    footer: `ID: ${params.view.approvalId}`,
    accentColor,
  });
}

function createPluginResolvedContainer(params: {
  view: PluginApprovalResolvedView;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  const decisionLabel =
    params.view.decision === "allow-once"
      ? "Allowed (once)"
      : params.view.decision === "allow-always"
        ? "Allowed (always)"
        : "Denied";
  const accentColor =
    params.view.decision === "deny"
      ? "#ED4245"
      : params.view.decision === "allow-always"
        ? "#5865F2"
        : "#57F287";

  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: `Plugin Approval: ${decisionLabel}`,
    description: params.view.resolvedBy ? `Resolved by ${params.view.resolvedBy}` : "Resolved",
    commandPreview: formatCommandPreview(params.view.title, 700),
    commandSecondaryPreview: formatOptionalCommandPreview(params.view.description, 1000),
    metadataLines: buildApprovalMetadataLines(params.view.metadata),
    footer: `ID: ${params.view.approvalId}`,
    accentColor,
  });
}

function createExecExpiredContainer(params: {
  view: ExecApprovalExpiredView;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  const { commandPreview, commandSecondaryPreview } = resolveCommandPreviews(
    params.view.commandText,
    params.view.commandPreview,
    500,
    300,
  );
  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: "Exec Approval: Expired",
    description: "This approval request has expired.",
    commandPreview,
    commandSecondaryPreview,
    metadataLines: buildApprovalMetadataLines(params.view.metadata),
    footer: `ID: ${params.view.approvalId}`,
    accentColor: "#99AAB5",
  });
}

function createPluginExpiredContainer(params: {
  view: PluginApprovalExpiredView;
  cfg: OpenClawConfig;
  accountId: string;
}): ExecApprovalContainer {
  return new ExecApprovalContainer({
    cfg: params.cfg,
    accountId: params.accountId,
    title: "Plugin Approval: Expired",
    description: "This approval request has expired.",
    commandPreview: formatCommandPreview(params.view.title, 700),
    commandSecondaryPreview: formatOptionalCommandPreview(params.view.description, 1000),
    metadataLines: buildApprovalMetadataLines(params.view.metadata),
    footer: `ID: ${params.view.approvalId}`,
    accentColor: "#99AAB5",
  });
}

export function buildExecApprovalCustomId(
  approvalId: string,
  action: ExecApprovalDecision,
): string {
  return [`execapproval:id=${encodeURIComponent(approvalId)}`, `action=${action}`].join(";");
}

async function updateMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  token: string;
  channelId: string;
  messageId: string;
  container: DiscordUiContainer;
}): Promise<void> {
  try {
    const { rest, request: discordRequest } = createDiscordClient({
      cfg: params.cfg,
      token: params.token,
      accountId: params.accountId,
    });
    const payload = buildExecApprovalPayload(params.container);
    await discordRequest(
      () =>
        rest.patch(Routes.channelMessage(params.channelId, params.messageId), {
          body: stripUndefinedFields(serializePayload(payload)),
        }),
      "update-approval",
    );
  } catch (err) {
    logError(`discord approvals: failed to update message: ${String(err)}`);
  }
}

async function finalizeMessage(params: {
  cfg: OpenClawConfig;
  accountId: string;
  token: string;
  cleanupAfterResolve?: boolean;
  channelId: string;
  messageId: string;
  container: DiscordUiContainer;
}): Promise<void> {
  if (!params.cleanupAfterResolve) {
    await updateMessage(params);
    return;
  }
  try {
    const { rest, request: discordRequest } = createDiscordClient({
      cfg: params.cfg,
      token: params.token,
      accountId: params.accountId,
    });
    await discordRequest(
      () => rest.delete(Routes.channelMessage(params.channelId, params.messageId)) as Promise<void>,
      "delete-approval",
    );
  } catch (err) {
    logError(`discord approvals: failed to delete message: ${String(err)}`);
    await updateMessage(params);
  }
}

export const discordApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  DiscordPendingDelivery,
  PreparedDeliveryTarget,
  PendingApproval,
  never
>({
  eventKinds: ["exec", "plugin"],
  resolveApprovalKind: (request) => (request.id.startsWith("plugin:") ? "plugin" : "exec"),
  availability: {
    isConfigured: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? isDiscordExecApprovalClientEnabled({
            cfg: params.cfg,
            accountId: resolved.accountId,
            configOverride: resolved.context.config,
          })
        : false;
    },
    shouldHandle: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? shouldHandleDiscordApprovalRequest({
            cfg: params.cfg,
            accountId: resolved.accountId,
            request: params.request,
            configOverride: resolved.context.config,
          })
        : false;
    },
  },
  presentation: {
    buildPendingPayload: ({ cfg, accountId, context, view }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return { body: {} };
      }
      const actionRow = createApprovalActionRow(view);
      const container =
        view.approvalKind === "plugin"
          ? createPluginApprovalRequestContainer({
              view: view,
              cfg,
              accountId: resolved.accountId,
              actionRow,
            })
          : createExecApprovalRequestContainer({
              view: view,
              cfg,
              accountId: resolved.accountId,
              actionRow,
            });
      return {
        body: stripUndefinedFields(serializePayload(buildExecApprovalPayload(container))),
      };
    },
    buildResolvedResult: ({ cfg, accountId, context, view }) => {
      const resolvedContext = resolveHandlerContext({ cfg, accountId, context });
      if (!resolvedContext) {
        return { kind: "delete" } as const;
      }
      const container =
        view.approvalKind === "plugin"
          ? createPluginResolvedContainer({
              view: view,
              cfg,
              accountId: resolvedContext.accountId,
            })
          : createExecResolvedContainer({
              view: view,
              cfg,
              accountId: resolvedContext.accountId,
            });
      return { kind: "update", payload: container } as const;
    },
    buildExpiredResult: ({ cfg, accountId, context, view }) => {
      const resolvedContext = resolveHandlerContext({ cfg, accountId, context });
      if (!resolvedContext) {
        return { kind: "delete" } as const;
      }
      const container =
        view.approvalKind === "plugin"
          ? createPluginExpiredContainer({
              view: view,
              cfg,
              accountId: resolvedContext.accountId,
            })
          : createExecExpiredContainer({
              view: view,
              cfg,
              accountId: resolvedContext.accountId,
            });
      return { kind: "update", payload: container } as const;
    },
  },
  transport: {
    prepareTarget: async ({ cfg, accountId, context, plannedTarget }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return null;
      }
      if (plannedTarget.surface === "origin") {
        const destinationId =
          typeof plannedTarget.target.threadId === "string" &&
          plannedTarget.target.threadId.trim().length > 0
            ? plannedTarget.target.threadId.trim()
            : plannedTarget.target.to;
        return {
          dedupeKey: destinationId,
          target: {
            discordChannelId: destinationId,
          },
        };
      }
      const { rest, request: discordRequest } = createDiscordClient({
        cfg,
        token: resolved.context.token,
        accountId: resolved.accountId,
      });
      const userId = plannedTarget.target.to;
      const dmChannel = (await discordRequest(
        () =>
          rest.post(Routes.userChannels(), {
            body: { recipient_id: userId },
          }) as Promise<{ id: string }>,
        "dm-channel",
      )) as { id: string };
      if (!dmChannel?.id) {
        logError(`discord approvals: failed to create DM for user ${userId}`);
        return null;
      }
      return {
        dedupeKey: dmChannel.id,
        target: {
          discordChannelId: dmChannel.id,
          recipientUserId: userId,
        },
      };
    },
    deliverPending: async ({
      cfg,
      accountId,
      context,
      plannedTarget,
      preparedTarget,
      pendingPayload,
    }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return null;
      }
      const { rest, request: discordRequest } = createDiscordClient({
        cfg,
        token: resolved.context.token,
        accountId: resolved.accountId,
      });
      const message = (await discordRequest(
        () =>
          rest.post(Routes.channelMessages(preparedTarget.discordChannelId), {
            body: pendingPayload.body,
          }) as Promise<{ id: string; channel_id: string }>,
        plannedTarget.surface === "origin" ? "send-approval-channel" : "send-approval",
      )) as { id: string; channel_id: string };
      if (!message?.id) {
        if (plannedTarget.surface === "origin") {
          logError("discord approvals: failed to send to channel");
        } else if (preparedTarget.recipientUserId) {
          logError(
            `discord approvals: failed to send message to user ${preparedTarget.recipientUserId}`,
          );
        }
        return null;
      }
      return {
        discordMessageId: message.id,
        discordChannelId: preparedTarget.discordChannelId,
      };
    },
    updateEntry: async ({ cfg, accountId, context, entry, payload, phase }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return;
      }
      const container = payload as DiscordUiContainer;
      await finalizeMessage({
        cfg,
        accountId: resolved.accountId,
        token: resolved.context.token,
        cleanupAfterResolve:
          phase === "resolved" ? resolved.context.config.cleanupAfterResolve : false,
        channelId: entry.discordChannelId,
        messageId: entry.discordMessageId,
        container,
      });
    },
  },
  observe: {
    onDuplicateSkipped: ({ preparedTarget, request }) => {
      logDebug(
        `discord approvals: skipping duplicate approval ${request.id} for channel ${preparedTarget.dedupeKey}`,
      );
    },
    onDelivered: ({ plannedTarget, preparedTarget, request }) => {
      if (plannedTarget.surface === "origin") {
        logDebug(
          `discord approvals: sent approval ${request.id} to channel ${preparedTarget.target.discordChannelId}`,
        );
        return;
      }
      logDebug(`discord approvals: sent approval ${request.id} to user ${plannedTarget.target.to}`);
    },
    onDeliveryError: ({ error, plannedTarget }) => {
      if (plannedTarget.surface === "origin") {
        logError(`discord approvals: failed to send to channel: ${String(error)}`);
        return;
      }
      logError(
        `discord approvals: failed to notify user ${plannedTarget.target.to}: ${String(error)}`,
      );
    },
  },
});
