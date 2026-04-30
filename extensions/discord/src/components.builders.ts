import crypto from "node:crypto";
import { ButtonStyle, MessageFlags } from "discord-api-types/v10";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
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
    style = style;
    emoji = params.spec.emoji;
    disabled = params.spec.disabled ?? false;
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
      callbackData: params.spec.callbackData,
      modalId: params.modalId,
      allowedUsers: params.spec.allowedUsers,
    },
  };
}

function createSelectComponent(params: {
  spec: DiscordComponentSelectSpec;
  componentId?: string;
}): {
  component:
    | StringSelectMenu
    | UserSelectMenu
    | RoleSelectMenu
    | MentionableSelectMenu
    | ChannelSelectMenu;
  entry: DiscordComponentEntry;
} {
  const type = normalizeLowercaseStringOrEmpty(
    params.spec.type ?? "string",
  ) as DiscordComponentSelectType;
  const componentId = params.componentId ?? createShortId("sel_");
  const customId = buildDiscordComponentCustomIdImpl({ componentId });
  const createEntry = (
    selectType: DiscordComponentSelectType,
    label: string,
    options?: DiscordComponentEntry["options"],
  ): DiscordComponentEntry => ({
    id: componentId,
    kind: "select",
    label,
    callbackData: params.spec.callbackData,
    selectType,
    ...(options ? { options } : {}),
    allowedUsers: params.spec.allowedUsers,
  });

  if (type === "string") {
    const options = params.spec.options ?? [];
    if (options.length === 0) {
      throw new Error("String select menus require options");
    }
    class DynamicStringSelect extends StringSelectMenu {
      customId = customId;
      options = options;
      minValues = params.spec.minValues;
      maxValues = params.spec.maxValues;
      placeholder = params.spec.placeholder;
      disabled = false;
    }
    return {
      component: new DynamicStringSelect(),
      entry: createEntry(
        "string",
        params.spec.placeholder ?? "select",
        options.map((option) => ({ value: option.value, label: option.label })),
      ),
    };
  }
  if (type === "user") {
    class DynamicUserSelect extends UserSelectMenu {
      customId = customId;
      minValues = params.spec.minValues;
      maxValues = params.spec.maxValues;
      placeholder = params.spec.placeholder;
      disabled = false;
    }
    return {
      component: new DynamicUserSelect(),
      entry: createEntry("user", params.spec.placeholder ?? "user select"),
    };
  }
  if (type === "role") {
    class DynamicRoleSelect extends RoleSelectMenu {
      customId = customId;
      minValues = params.spec.minValues;
      maxValues = params.spec.maxValues;
      placeholder = params.spec.placeholder;
      disabled = false;
    }
    return {
      component: new DynamicRoleSelect(),
      entry: createEntry("role", params.spec.placeholder ?? "role select"),
    };
  }
  if (type === "mentionable") {
    class DynamicMentionableSelect extends MentionableSelectMenu {
      customId = customId;
      minValues = params.spec.minValues;
      maxValues = params.spec.maxValues;
      placeholder = params.spec.placeholder;
      disabled = false;
    }
    return {
      component: new DynamicMentionableSelect(),
      entry: createEntry("mentionable", params.spec.placeholder ?? "mentionable select"),
    };
  }
  class DynamicChannelSelect extends ChannelSelectMenu {
    customId = customId;
    minValues = params.spec.minValues;
    maxValues = params.spec.maxValues;
    placeholder = params.spec.placeholder;
    disabled = false;
  }
  return {
    component: new DynamicChannelSelect(),
    entry: createEntry("channel", params.spec.placeholder ?? "channel select"),
  };
}

function isSelectComponent(
  component: unknown,
): component is
  | StringSelectMenu
  | UserSelectMenu
  | RoleSelectMenu
  | MentionableSelectMenu
  | ChannelSelectMenu {
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
    entries.push({
      ...entry,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      accountId: params.accountId,
      reusable: entry.reusable ?? params.spec.reusable,
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
      description: field.description,
      placeholder: field.placeholder,
      required: field.required,
      options: field.options,
      minValues: field.minValues,
      maxValues: field.maxValues,
      minLength: field.minLength,
      maxLength: field.maxLength,
      style: field.style,
    }));
    modals.push({
      id: modalId,
      title: params.spec.modal.title,
      callbackData: params.spec.modal.callbackData,
      fields,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      accountId: params.accountId,
      reusable: params.spec.reusable,
      allowedUsers: params.spec.modal.allowedUsers,
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
      const hasSelect = row.components.some((entry) => isSelectComponent(entry));
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
  return { components, entries, modals };
}

export function buildDiscordComponentMessageFlags(
  components: TopLevelComponents[],
): number | undefined {
  const hasV2 = components.some((component) => component.isV2);
  return hasV2 ? MessageFlags.IsComponentsV2 : undefined;
}
