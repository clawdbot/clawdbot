import { ButtonStyle, ComponentType } from "discord-api-types/v10";
import { parseDiscordComponentCustomIdForInteraction } from "../component-custom-id.js";
import {
  BaseMessageInteractiveComponent,
  Button,
  type ButtonInteraction,
  type ComponentData,
} from "../internal/discord.js";
import {
  parseDiscordComponentData,
  resolveInteractionCustomId,
  type AgentComponentContext,
  type AgentComponentMessageInteraction,
} from "./agent-components-helpers.js";

export type DiscordComponentControlHandlers = {
  handleComponentEvent: (params: {
    ctx: AgentComponentContext;
    interaction: AgentComponentMessageInteraction;
    data: ComponentData;
    componentLabel: string;
    values?: string[];
    label: string;
  }) => Promise<void>;
  handleModalTrigger: (params: {
    ctx: AgentComponentContext;
    interaction: ButtonInteraction;
    data: ComponentData;
    label: string;
  }) => Promise<void>;
};

type SelectControlSpec = {
  type: ComponentType;
  customId: string;
  componentLabel: string;
  label: string;
};

const SELECT_CONTROLS = {
  string: {
    type: ComponentType.StringSelect,
    customId: "__openclaw_discord_component_string_select_wildcard__",
    componentLabel: "select menu",
    label: "discord component select",
  },
  user: {
    type: ComponentType.UserSelect,
    customId: "__openclaw_discord_component_user_select_wildcard__",
    componentLabel: "user select",
    label: "discord component user select",
  },
  role: {
    type: ComponentType.RoleSelect,
    customId: "__openclaw_discord_component_role_select_wildcard__",
    componentLabel: "role select",
    label: "discord component role select",
  },
  mentionable: {
    type: ComponentType.MentionableSelect,
    customId: "__openclaw_discord_component_mentionable_select_wildcard__",
    componentLabel: "mentionable select",
    label: "discord component mentionable select",
  },
  channel: {
    type: ComponentType.ChannelSelect,
    customId: "__openclaw_discord_component_channel_select_wildcard__",
    componentLabel: "channel select",
    label: "discord component channel select",
  },
} satisfies Record<string, SelectControlSpec>;

class DiscordComponentSelectControl extends BaseMessageInteractiveComponent {
  customIdParser = parseDiscordComponentCustomIdForInteraction;
  readonly type: ComponentType;
  readonly customId: string;

  constructor(
    private spec: SelectControlSpec,
    private ctx: AgentComponentContext,
    private handlers: DiscordComponentControlHandlers,
  ) {
    super();
    this.type = spec.type;
    this.customId = spec.customId;
  }

  serialize(): unknown {
    return this.type === ComponentType.StringSelect
      ? { type: this.type, custom_id: this.customId, options: [] }
      : { type: this.type, custom_id: this.customId };
  }

  async run(interaction: AgentComponentMessageInteraction, data: ComponentData): Promise<void> {
    await this.handlers.handleComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: this.spec.componentLabel,
      label: this.spec.label,
      values: interaction.values ?? [],
    });
  }
}

class DiscordComponentButton extends Button {
  label = "component";
  customId = "__openclaw_discord_component_button_wildcard__";
  style = ButtonStyle.Primary;
  customIdParser = parseDiscordComponentCustomIdForInteraction;

  constructor(
    private ctx: AgentComponentContext,
    private handlers: DiscordComponentControlHandlers,
  ) {
    super();
  }

  async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    const parsed = parseDiscordComponentData(data, resolveInteractionCustomId(interaction));
    if (parsed?.modalId) {
      await this.handlers.handleModalTrigger({
        ctx: this.ctx,
        interaction,
        data,
        label: "discord component modal",
      });
      return;
    }
    await this.handlers.handleComponentEvent({
      ctx: this.ctx,
      interaction,
      data,
      componentLabel: "button",
      label: "discord component button",
    });
  }
}

function createSelectControl(
  spec: SelectControlSpec,
  ctx: AgentComponentContext,
  handlers: DiscordComponentControlHandlers,
): BaseMessageInteractiveComponent {
  return new DiscordComponentSelectControl(spec, ctx, handlers);
}

function bindSelectControl(spec: SelectControlSpec) {
  return (ctx: AgentComponentContext, handlers: DiscordComponentControlHandlers) =>
    createSelectControl(spec, ctx, handlers);
}

export function createDiscordComponentButtonControl(
  ctx: AgentComponentContext,
  handlers: DiscordComponentControlHandlers,
): Button {
  return new DiscordComponentButton(ctx, handlers);
}

export const createDiscordComponentStringSelectControl = bindSelectControl(SELECT_CONTROLS.string);
export const createDiscordComponentUserSelectControl = bindSelectControl(SELECT_CONTROLS.user);
export const createDiscordComponentRoleSelectControl = bindSelectControl(SELECT_CONTROLS.role);
export const createDiscordComponentMentionableSelectControl = bindSelectControl(
  SELECT_CONTROLS.mentionable,
);
export const createDiscordComponentChannelSelectControl = bindSelectControl(
  SELECT_CONTROLS.channel,
);
