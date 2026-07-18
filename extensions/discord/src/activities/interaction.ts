import { logError } from "openclaw/plugin-sdk/logging-core";
import {
  buildDiscordActivityCustomId,
  parseDiscordActivityCustomIdForInteraction,
} from "../component-custom-id.js";
import type { ButtonInteraction, ComponentData } from "../internal/discord.js";
import { Button } from "../internal/discord.js";
import { resolveAuthorizedComponentInteraction } from "../monitor/agent-components-auth.js";
import { replySilently } from "../monitor/agent-components-reply.js";
import type { AgentComponentContext } from "../monitor/agent-components.types.js";
import { getDiscordActivitiesRuntime } from "./runtime.js";

const REGISTRATION_WIDGET_ID = "AAAAAAAAAAAAAAAAAAAAAA";

const PENDING_LAUNCH_WRITE_BUDGET_MS = 250;

class DiscordActivityButton extends Button {
  label = "Open widget";
  customId = buildDiscordActivityCustomId(REGISTRATION_WIDGET_ID);
  override customIdParser = parseDiscordActivityCustomIdForInteraction;

  constructor(
    private readonly ctx: AgentComponentContext,
    private readonly deps: {
      authorize: typeof resolveAuthorizedComponentInteraction;
      reply: typeof replySilently;
      logError: (message: string) => void;
    },
  ) {
    super();
  }

  private pendingLaunchFailureLogged = false;

  private logPendingLaunchFailure(error: unknown): void {
    if (this.pendingLaunchFailureLogged) {
      return;
    }
    this.pendingLaunchFailureLogged = true;
    this.deps.logError(`discord activity: failed to record pending launch: ${String(error)}`);
  }

  override async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    if (typeof data.widgetId !== "string") {
      await this.deps.reply(interaction, {
        content: "This widget is no longer valid.",
        ephemeral: true,
      });
      return;
    }
    const authorized = await this.deps.authorize({
      ctx: this.ctx,
      interaction,
      label: "discord activity",
      componentLabel: "widget button",
      unauthorizedReply: "not allowed",
      defer: false,
    });
    if (!authorized) {
      return;
    }
    if (!authorized.commandAuthorized) {
      await this.deps.reply(interaction, { content: "not allowed", ephemeral: true });
      return;
    }
    const runtime = getDiscordActivitiesRuntime();
    const channelId = interaction.rawData.channel_id;
    const discordUserId = interaction.userId;
    if (!runtime || !channelId || !discordUserId) {
      this.logPendingLaunchFailure(new Error("missing activity runtime or interaction identity"));
    } else {
      // Await the write within a small budget so the record is visible before the Activity
      // can query api/widget, while never risking Discord's 3-second interaction ack: a
      // healthy store commits in single-digit milliseconds; on timeout the write continues
      // in the background and the mangled-ID multi-widget case degrades to fail-closed.
      const write = runtime.store
        .recordPendingLaunch({
          accountId: this.ctx.accountId,
          channelId,
          discordUserId,
          widgetId: data.widgetId,
          createdAt: Date.now(),
        })
        .then(() => "written" as const)
        .catch((error: unknown) => {
          this.logPendingLaunchFailure(error);
          return "failed" as const;
        });
      const timeout = new Promise<"timeout">((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), PENDING_LAUNCH_WRITE_BUDGET_MS);
        timer.unref?.();
      });
      if ((await Promise.race([write, timeout])) === "timeout") {
        this.logPendingLaunchFailure(
          new Error(`pending launch write exceeded ${PENDING_LAUNCH_WRITE_BUDGET_MS}ms`),
        );
      }
    }
    await interaction.launchActivity();
  }
}

export function createDiscordActivityButton(
  ctx: AgentComponentContext,
  applicationId?: string,
  deps: {
    authorize?: typeof resolveAuthorizedComponentInteraction;
    reply?: typeof replySilently;
    logError?: (message: string) => void;
  } = {},
): DiscordActivityButton | null {
  const runtime = getDiscordActivitiesRuntime();
  if (!runtime || !runtime.isAccountEnabled(ctx.accountId, ctx.cfg)) {
    return null;
  }
  if (applicationId) {
    runtime.registerApplicationId(ctx.accountId, applicationId);
  }
  if (!runtime.resolveAccount(ctx.accountId, ctx.cfg)) {
    return null;
  }
  return new DiscordActivityButton(ctx, {
    authorize: deps.authorize ?? resolveAuthorizedComponentInteraction,
    reply: deps.reply ?? replySilently,
    logError: deps.logError ?? logError,
  });
}
