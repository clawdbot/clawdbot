import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatUnknownError } from "./errors.js";
import { resolveMSTeamsSenderAccess } from "./monitor-handler/access.js";
import { createMSTeamsMessageHandler } from "./monitor-handler/message-handler.js";
import { createMSTeamsReactionHandler } from "./monitor-handler/reaction-handler.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";
import { buildGroupWelcomeText, buildWelcomeCard } from "./welcome-card.js";
export type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";

export type MSTeamsActivityHandler = {
  onMessage: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onMembersAdded: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onReactionsAdded: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  onReactionsRemoved: (
    handler: (context: unknown, next: () => Promise<void>) => Promise<void>,
  ) => MSTeamsActivityHandler;
  run?: (context: unknown) => Promise<void>;
};

function serializeAdaptiveCardActionValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

async function isInvokeAuthorized(params: {
  context: MSTeamsTurnContext;
  deps: MSTeamsMessageHandlerDeps;
  deniedLogs: {
    dm: string;
    channel: string;
    group: string;
  };
  includeInvokeName?: boolean;
}): Promise<boolean> {
  const { context, deps, deniedLogs, includeInvokeName = false } = params;
  const resolved = await resolveMSTeamsSenderAccess({
    cfg: deps.cfg,
    activity: context.activity,
  });
  const { msteamsCfg, isDirectMessage, conversationId, senderId } = resolved;
  if (!msteamsCfg) {
    return true;
  }

  const maybeInvokeName = includeInvokeName ? { name: context.activity.name } : undefined;

  if (isDirectMessage && resolved.senderAccess.decision !== "allow") {
    deps.log.debug?.(deniedLogs.dm, {
      sender: senderId,
      conversationId,
      ...maybeInvokeName,
    });
    return false;
  }

  if (
    !isDirectMessage &&
    resolved.channelGate.allowlistConfigured &&
    !resolved.channelGate.allowed
  ) {
    deps.log.debug?.(deniedLogs.channel, {
      conversationId,
      teamKey: resolved.channelGate.teamKey ?? "none",
      channelKey: resolved.channelGate.channelKey ?? "none",
      ...maybeInvokeName,
    });
    return false;
  }

  if (!isDirectMessage && !resolved.senderAccess.allowed) {
    deps.log.debug?.(deniedLogs.group, {
      sender: senderId,
      conversationId,
      ...maybeInvokeName,
    });
    return false;
  }

  return true;
}

export async function isFeedbackInvokeAuthorized(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<boolean> {
  return isInvokeAuthorized({
    context,
    deps,
    deniedLogs: {
      dm: "dropping feedback invoke (dm sender not allowlisted)",
      channel: "dropping feedback invoke (not in team/channel allowlist)",
      group: "dropping feedback invoke (group sender not allowlisted)",
    },
  });
}

export async function isSigninInvokeAuthorized(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<boolean> {
  return isInvokeAuthorized({
    context,
    deps,
    deniedLogs: {
      dm: "dropping signin invoke (dm sender not allowlisted)",
      channel: "dropping signin invoke (not in team/channel allowlist)",
      group: "dropping signin invoke (group sender not allowlisted)",
    },
    includeInvokeName: true,
  });
}

export async function isCardActionInvokeAuthorized(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<boolean> {
  return isInvokeAuthorized({
    context,
    deps,
    deniedLogs: {
      dm: "dropping card action invoke (dm sender not allowlisted)",
      channel: "dropping card action invoke (not in team/channel allowlist)",
      group: "dropping card action invoke (group sender not allowlisted)",
    },
    includeInvokeName: true,
  });
}

export function registerMSTeamsHandlers<T extends MSTeamsActivityHandler>(
  handler: T,
  deps: MSTeamsMessageHandlerDeps,
): T {
  const handleTeamsMessage = createMSTeamsMessageHandler(deps);
  const handleReaction = createMSTeamsReactionHandler(deps);

  // Wrap the original run method to intercept invokes
  const originalRun = handler.run;
  if (originalRun) {
    handler.run = async (context: unknown) => {
      const ctx = context as MSTeamsTurnContext;
      // Non-poll adaptiveCard/action invokes get dispatched here as text so the
      // agent can react. Poll votes are intercepted in monitor.ts's
      // app.on("card.action") handler which returns the InvokeResponse to Teams.
      if (ctx.activity?.type === "invoke" && ctx.activity?.name === "adaptiveCard/action") {
        const text = serializeAdaptiveCardActionValue(ctx.activity?.value);
        if (text) {
          await handleTeamsMessage({
            ...ctx,
            activity: {
              ...ctx.activity,
              type: "message",
              text,
            },
          });
        }
        return;
      }

      return originalRun.call(handler, context);
    };
  }

  handler.onMessage(async (context, next) => {
    try {
      await handleTeamsMessage(context as MSTeamsTurnContext);
    } catch (err) {
      deps.runtime.error(`msteams handler failed: ${formatUnknownError(err)}`);
    }
    await next();
  });

  handler.onMembersAdded(async (context, next) => {
    const ctx = context as MSTeamsTurnContext;
    const membersAdded = ctx.activity?.membersAdded ?? [];
    const botId = ctx.activity?.recipient?.id;
    const msteamsCfg = deps.cfg.channels?.msteams;

    for (const member of membersAdded) {
      if (member.id === botId) {
        // Bot was added to a conversation — send welcome card if configured.
        const conversationType =
          normalizeOptionalLowercaseString(ctx.activity?.conversation?.conversationType) ??
          "personal";
        const isPersonal = conversationType === "personal";

        if (isPersonal && msteamsCfg?.welcomeCard !== false) {
          const botName = ctx.activity?.recipient?.name ?? undefined;
          const card = buildWelcomeCard({
            botName,
            promptStarters: msteamsCfg?.promptStarters,
          });
          try {
            await ctx.sendActivity({
              type: "message",
              attachments: [
                {
                  contentType: "application/vnd.microsoft.card.adaptive",
                  content: card,
                },
              ],
            });
            deps.log.info("sent welcome card");
          } catch (err) {
            deps.log.debug?.("failed to send welcome card", { error: formatUnknownError(err) });
          }
        } else if (!isPersonal && msteamsCfg?.groupWelcomeCard === true) {
          const botName = ctx.activity?.recipient?.name ?? undefined;
          try {
            await ctx.sendActivity(buildGroupWelcomeText(botName));
            deps.log.info("sent group welcome message");
          } catch (err) {
            deps.log.debug?.("failed to send group welcome", { error: formatUnknownError(err) });
          }
        } else {
          deps.log.debug?.("skipping welcome (disabled by config or conversation type)");
        }
      } else {
        deps.log.debug?.("member added", { member: member.id });
      }
    }
    await next();
  });

  handler.onReactionsAdded(async (context, next) => {
    try {
      await handleReaction(context as MSTeamsTurnContext, "added");
    } catch (err) {
      deps.runtime.error(`msteams reaction handler failed: ${String(err)}`);
    }
    await next();
  });

  handler.onReactionsRemoved(async (context, next) => {
    try {
      await handleReaction(context as MSTeamsTurnContext, "removed");
    } catch (err) {
      deps.runtime.error(`msteams reaction handler failed: ${String(err)}`);
    }
    await next();
  });

  return handler;
}
