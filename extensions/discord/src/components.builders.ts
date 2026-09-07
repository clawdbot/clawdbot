// Discord plugin module implements components.builders behavior.
import crypto from "node:crypto";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildDiscordComponentCustomId as buildDiscordComponentCustomIdImpl } from "./component-custom-id.js";
import { mapButtonStyle, normalizeModalFieldName } from "./components.parse.js";
import type {
  DiscordComponentBuildResult,
  DiscordComponentButtonSpec,
  DiscordComponentEntry,
  DiscordComponentMessageSpec,
  DiscordComponentSelectSpec,
  DiscordComponentSelectType,
  DiscordModalEntry,
} from "./components.types.js";
import {
  Button,
  ChannelSelectMenu,
  Container,
  File,
  LinkButton,
  MediaGallery,
  MentionableSelectMenu,
  RoleSelectMenu,
  Row,
  Section,
  Separator,
  StringSelectMenu,
  TextDisplay,
  Thumbnail,
  UserSelectMenu,
  type TopLevelComponents,
} from "./internal/discord.js";

function createShortId(prefix: string) {
  return `${prefix}${crypto.randomBytes(6).toString("base64url")}`;
}

type DiscordSelectMenuByType = {
  string: StringSelectMenu;
  user: UserSelectMenu;
  role: RoleSelectMenu;
  mentionable: MentionableSelectMenu;
  channel: ChannelSelectMenu;
};
type DiscordSelectMenu = DiscordSelectMenuByType[DiscordComponentSelectType];

const selectMenuConstructors = {
  string: class extends StringSelectMenu {
    customId = "";
    override options: NonNullable<DiscordComponentSelectSpec["options"]> = [];
  },
  user: class extends UserSelectMenu {
    customId = "";
  },
  role: class extends RoleSelectMenu {
    customId = "";
  },
  mentionable: class extends MentionableSelectMenu {
    customId = "";
  },
  channel: class extends ChannelSelectMenu {
    customId = "";
  },
} satisfies {
  [Type in DiscordComponentSelectType]: new () => DiscordSelectMenuByType[Type];
};

export function createDiscordSelectMenu<Type extends DiscordComponentSelectType>(
  type: Type,
  customId: string,
  options?: DiscordComponentSelectSpec["options"],
): DiscordSelectMenuByType[Type] {
  // SAFETY: the constructor map satisfies the same Type-to-select-class relationship.
  const SelectMenu = selectMenuConstructors[type] as new () => DiscordSelectMenuByType[Type];
  const select = new SelectMenu();
  select.customId = customId;
  if (select instanceof StringSelectMenu) {
    select.options = options ?? [];
  }
  return select;
}

function buildTextDisplays(text?: string, texts?: string[]): TextDisplay[] {
  if (texts && texts.length > 0) {
    return texts.map((entry) => new TextDisplay(entry));
  }
  if (text) {
    return [new TextDisplay(text)];
  }
  return [];
}

function createButtonComponent(params: {
  spec: DiscordComponentButtonSpec;
  componentId?: string;
  modalId?: string;
}): { component: Button | LinkButton; entry?: DiscordComponentEntry } {
  const style = mapButtonStyle(params.spec.style);
  const isLink = style === ButtonStyle.Link || Boolean(params.spec.url);
  if (isLink) {
    if (!params.spec.url) {
      throw new Error("Link buttons require a url");
    }
    const linkUrl = params.spec.url;
    class DynamicLinkButton extends LinkButton {
      label = params.spec.label;
      url = linkUrl;
      override disabled = params.spec.disabled ?? false;
    }
    return { component: new DynamicLinkButton() };
  }
  const componentId = params.componentId ?? createShortId("btn_");
  const internalCustomId =
    typeof params.spec.internalCustomId === "string" && params.spec.internalCustomId.trim()
      ? params.spec.internalCustomId.trim()
      : undefined;
  const customId =
    internalCustomId ??
    buildDiscordComponentCustomIdImpl({
      componentId,
      modalId: params.modalId,
    });
  class DynamicButton extends Button {
    label = params.spec.label;
    customId = customId;
    override style = style;
    override emoji = params.spec.emoji;
    override disabled = params.spec.disabled ?? false;
  }
  if (internalCustomId) {
    return {
      component: new DynamicButton(),
    };
  }
  return {
    component: new DynamicButton(),
    entry: {
      id: componentId,
      kind: params.modalId ? "modal-trigger" : "button",
      label: params.spec.label,
      ...(params.spec.callbackData !== undefined ? { callbackData: params.spec.callbackData } : {}),
      ...(params.spec.callbackDataKind !== undefined
        ? { callbackDataKind: params.spec.callbackDataKind }
        : {}),
      ...(params.modalId !== undefined ? { modalId: params.modalId } : {}),
      ...(params.spec.reusable !== undefined ? { reusable: params.spec.reusable } : {}),
      ...(params.spec.allowedUsers !== undefined ? { allowedUsers: params.spec.allowedUsers } : {}),
    },
  };
}

function createSelectComponent(params: {
  spec: DiscordComponentSelectSpec;
  componentId?: string;
}): {
  component: DiscordSelectMenu;
  entry: DiscordComponentEntry;
} {
  const type = normalizeLowercaseStringOrEmpty(
    params.spec.type ?? "string",
  ) as DiscordComponentSelectType;
  const componentId = params.componentId ?? createShortId("sel_");
  const customId = buildDiscordComponentCustomIdImpl({ componentId });
  const options = params.spec.options ?? [];
  if (type === "string" && options.length === 0) {
    throw new Error("String select menus require options");
  }
  const select = createDiscordSelectMenu(type, customId, options);
  select.minValues = params.spec.minValues;
  select.maxValues = params.spec.maxValues;
  select.placeholder = params.spec.placeholder;
  select.disabled = false;
  const labels: Record<DiscordComponentSelectType, string> = {
    string: "select",
    user: "user select",
    role: "role select",
    mentionable: "mentionable select",
    channel: "channel select",
  };
  return {
    component: select,
    entry: {
      id: componentId,
      kind: "select",
      label: params.spec.placeholder ?? labels[type],
      ...(params.spec.callbackData !== undefined ? { callbackData: params.spec.callbackData } : {}),
      ...(params.spec.callbackDataKind !== undefined
        ? { callbackDataKind: params.spec.callbackDataKind }
        : {}),
      selectType: type,
      ...(type === "string"
        ? { options: options.map((option) => ({ value: option.value, label: option.label })) }
        : {}),
      ...(params.spec.allowedUsers !== undefined ? { allowedUsers: params.spec.allowedUsers } : {}),
    },
  };
}

function isSelectComponent(component: unknown): component is DiscordSelectMenu {
  return (
    component instanceof StringSelectMenu ||
    component instanceof UserSelectMenu ||
    component instanceof RoleSelectMenu ||
    component instanceof MentionableSelectMenu ||
    component instanceof ChannelSelectMenu
  );
}

export function buildDiscordComponentMessage(params: {
  spec: DiscordComponentMessageSpec;
  fallbackText?: string;
  sessionKey?: string;
  agentId?: string;
  accountId?: string;
}): DiscordComponentBuildResult {
  const entries: DiscordComponentEntry[] = [];
  const consumptionGroupId = createShortId("grp_");
  const modals: DiscordModalEntry[] = [];
  const components: TopLevelComponents[] = [];
  const containerChildren: Array<
    | Row<
        | Button
        | LinkButton
        | StringSelectMenu
        | UserSelectMenu
        | RoleSelectMenu
        | MentionableSelectMenu
        | ChannelSelectMenu
      >
    | TextDisplay
    | Section
    | MediaGallery
    | Separator
    | File
  > = [];

  const addEntry = (entry: DiscordComponentEntry) => {
    const reusable = entry.reusable ?? params.spec.reusable;
    entries.push({
      ...entry,
      ...(params.sessionKey !== undefined ? { sessionKey: params.sessionKey } : {}),
      ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
      ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
      ...(reusable !== undefined ? { reusable } : {}),
      consumptionGroupId,
    });
  };

  const text = params.spec.text ?? params.fallbackText;
  if (text) {
    containerChildren.push(new TextDisplay(text));
  }

  for (const block of params.spec.blocks ?? []) {
    if (block.type === "text") {
      containerChildren.push(new TextDisplay(block.text));
      continue;
    }
    if (block.type === "section") {
      const displays = buildTextDisplays(block.text, block.texts);
      if (displays.length > 3) {
        throw new Error("Section blocks support up to 3 text displays");
      }
      let accessory: Thumbnail | Button | LinkButton | undefined;
      if (block.accessory?.type === "thumbnail") {
        accessory = new Thumbnail(block.accessory.url);
      } else if (block.accessory?.type === "button") {
        const { component, entry } = createButtonComponent({ spec: block.accessory.button });
        accessory = component;
        if (entry) {
          addEntry(entry);
        }
      }
      containerChildren.push(new Section(displays, accessory));
      continue;
    }
    if (block.type === "separator") {
      containerChildren.push(new Separator({ spacing: block.spacing, divider: block.divider }));
      continue;
    }
    if (block.type === "media-gallery") {
      containerChildren.push(new MediaGallery(block.items));
      continue;
    }
    if (block.type === "file") {
      containerChildren.push(new File(block.file, block.spoiler));
      continue;
    }
    if (block.type === "actions") {
      const rowComponents: Array<
        | Button
        | LinkButton
        | StringSelectMenu
        | UserSelectMenu
        | RoleSelectMenu
        | MentionableSelectMenu
        | ChannelSelectMenu
      > = [];
      if (block.buttons) {
        if (block.buttons.length > 5) {
          throw new Error("Action rows support up to 5 buttons");
        }
        for (const button of block.buttons) {
          const { component, entry } = createButtonComponent({ spec: button });
          rowComponents.push(component);
          if (entry) {
            addEntry(entry);
          }
        }
      } else if (block.select) {
        const { component, entry } = createSelectComponent({ spec: block.select });
        rowComponents.push(component);
        addEntry(entry);
      }
      containerChildren.push(new Row(rowComponents));
    }
  }

  if (params.spec.modal) {
    const modalId = createShortId("mdl_");
    const fields = params.spec.modal.fields.map((field, index) => ({
      id: createShortId("fld_"),
      name: normalizeModalFieldName(field.name, index),
      label: field.label,
      type: field.type,
      ...(field.description !== undefined ? { description: field.description } : {}),
      ...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {}),
      ...(field.required !== undefined ? { required: field.required } : {}),
      ...(field.options !== undefined ? { options: field.options } : {}),
      ...(field.minValues !== undefined ? { minValues: field.minValues } : {}),
      ...(field.maxValues !== undefined ? { maxValues: field.maxValues } : {}),
      ...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
      ...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
      ...(field.style !== undefined ? { style: field.style } : {}),
    }));
    modals.push({
      id: modalId,
      title: params.spec.modal.title,
      fields,
      ...(params.spec.modal.callbackData !== undefined
        ? { callbackData: params.spec.modal.callbackData }
        : {}),
      ...(params.sessionKey !== undefined ? { sessionKey: params.sessionKey } : {}),
      ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
      ...(params.accountId !== undefined ? { accountId: params.accountId } : {}),
      ...(params.spec.reusable !== undefined ? { reusable: params.spec.reusable } : {}),
      ...(params.spec.modal.allowedUsers !== undefined
        ? { allowedUsers: params.spec.modal.allowedUsers }
        : {}),
    });

    const triggerSpec: DiscordComponentButtonSpec = {
      label: params.spec.modal.triggerLabel ?? "Open form",
      style: params.spec.modal.triggerStyle ?? "primary",
      allowedUsers: params.spec.modal.allowedUsers,
    };

    const { component, entry } = createButtonComponent({
      spec: triggerSpec,
      modalId,
    });

    if (entry) {
      addEntry(entry);
    }

    const lastChild = containerChildren.at(-1);
    if (lastChild instanceof Row) {
      const row = lastChild;
      const hasSelect = row.components.some((entryLocal) => isSelectComponent(entryLocal));
      if (row.components.length < 5 && !hasSelect) {
        row.addComponent(component as Button);
      } else {
        containerChildren.push(new Row([component as Button]));
      }
    } else {
      containerChildren.push(new Row([component as Button]));
    }
  }

  if (containerChildren.length === 0) {
    throw new Error("components must include at least one block, text, or modal trigger");
  }

  const container = new Container(containerChildren, params.spec.container);
  components.push(container);
  const consumptionGroupEntryIds = entries.map((entry) => entry.id);
  for (const entry of entries) {
    entry.consumptionGroupEntryIds = consumptionGroupEntryIds;
  }
  return { components, entries, modals };
}

export function buildDiscordComponentMessageFlags(
  components: TopLevelComponents[],
): number | undefined {
  const hasV2 = components.some((component) => component.isV2);
  return hasV2 ? MessageFlags.IsComponentsV2 : undefined;
}
