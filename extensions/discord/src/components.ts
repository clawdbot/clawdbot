import crypto from "node:crypto";
import {
  Button,
  ChannelSelectMenu,
  CheckboxGroup,
  Container,
  File,
  Label,
  LinkButton,
  MediaGallery,
  MentionableSelectMenu,
  Modal,
  RadioGroup,
  RoleSelectMenu,
  Row,
  Section,
  Separator,
  StringSelectMenu,
  TextDisplay,
  TextInput,
  Thumbnail,
  UserSelectMenu,
  type TopLevelComponents,
} from "@buape/carbon";
import { ButtonStyle, MessageFlags, TextInputStyle } from "discord-api-types/v10";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  buildDiscordComponentCustomId as buildDiscordComponentCustomIdImpl,
  buildDiscordModalCustomId as buildDiscordModalCustomIdImpl,
  parseDiscordModalCustomIdForCarbon as parseDiscordModalCustomIdForCarbonImpl,
} from "./component-custom-id.js";
import type {
  DiscordComponentBlock,
  DiscordComponentBuildResult,
  DiscordComponentButtonSpec,
  DiscordComponentButtonStyle,
  DiscordComponentEntry,
  DiscordComponentMessageSpec,
  DiscordComponentModalFieldType,
  DiscordComponentSectionAccessory,
  DiscordComponentSelectOption,
  DiscordComponentSelectSpec,
  DiscordComponentSelectType,
  DiscordModalEntry,
  DiscordModalFieldDefinition,
  DiscordModalFieldSpec,
  DiscordModalSpec,
} from "./components.types.js";
export type {
  DiscordComponentBlock,
  DiscordComponentBuildResult,
  DiscordComponentButtonSpec,
  DiscordComponentButtonStyle,
  DiscordComponentEntry,
  DiscordComponentMessageSpec,
  DiscordComponentModalFieldType,
  DiscordComponentSectionAccessory,
  DiscordComponentSelectOption,
  DiscordComponentSelectSpec,
  DiscordComponentSelectType,
  DiscordModalEntry,
  DiscordModalFieldDefinition,
  DiscordModalFieldSpec,
  DiscordModalSpec,
} from "./components.types.js";
// Some test-only module graphs partially mock `@buape/carbon` and can drop `Modal`.
// Keep dynamic form definitions loadable instead of crashing unrelated suites.
const ModalBase: typeof Modal = Modal ?? (function ModalFallback() {} as unknown as typeof Modal);

export const DISCORD_COMPONENT_ATTACHMENT_PREFIX = "attachment://";

type DiscordComponentSeparatorSpacing = "small" | "large" | 1 | 2;
export {
  DISCORD_COMPONENT_CUSTOM_ID_KEY,
  DISCORD_MODAL_CUSTOM_ID_KEY,
  buildDiscordComponentCustomId,
  buildDiscordModalCustomId,
  parseDiscordComponentCustomId,
  parseDiscordComponentCustomIdForCarbon,
  parseDiscordModalCustomId,
  parseDiscordModalCustomIdForCarbon,
} from "./component-custom-id.js";
export { buildDiscordInteractiveComponents } from "./shared-interactive.js";

const BLOCK_ALIASES = new Map<string, DiscordComponentBlock["type"]>([
  ["row", "actions"],
  ["action-row", "actions"],
]);

function createShortId(prefix: string) {
  return `${prefix}${crypto.randomBytes(6).toString("base64url")}`;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, label: string, opts?: { allowEmpty?: boolean }): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = value.trim();
  if (!opts?.allowEmpty && !trimmed) {
    throw new Error(`${label} cannot be empty`);
  }
  return opts?.allowEmpty ? value : trimmed;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  if (value.length === 0) {
    return undefined;
  }
  return value.map((entry, index) => readString(entry, `${label}[${index}]`));
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function normalizeModalFieldName(value: string | undefined, index: number) {
  const trimmed = value?.trim();
  if (trimmed) {
    return trimmed;
  }
  return `field_${index + 1}`;
}

function normalizeAttachmentRef(value: string, label: string): `attachment://${string}` {
  const trimmed = value.trim();
  if (!trimmed.startsWith(DISCORD_COMPONENT_ATTACHMENT_PREFIX)) {
    throw new Error(`${label} must start with "${DISCORD_COMPONENT_ATTACHMENT_PREFIX}"`);
  }
  const attachmentName = trimmed.slice(DISCORD_COMPONENT_ATTACHMENT_PREFIX.length).trim();
  if (!attachmentName) {
    throw new Error(`${label} must include an attachment filename`);
  }
  return `${DISCORD_COMPONENT_ATTACHMENT_PREFIX}${attachmentName}`;
}

export function resolveDiscordComponentAttachmentName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith(DISCORD_COMPONENT_ATTACHMENT_PREFIX)) {
    throw new Error(
      `Attachment reference must start with "${DISCORD_COMPONENT_ATTACHMENT_PREFIX}"`,
    );
  }
  const attachmentName = trimmed.slice(DISCORD_COMPONENT_ATTACHMENT_PREFIX.length).trim();
  if (!attachmentName) {
    throw new Error("Attachment reference must include a filename");
  }
  return attachmentName;
}

function mapButtonStyle(style?: DiscordComponentButtonStyle): ButtonStyle {
  switch (normalizeLowercaseStringOrEmpty(style ?? "primary")) {
    case "secondary":
      return ButtonStyle.Secondary;
    case "success":
      return ButtonStyle.Success;
    case "danger":
      return ButtonStyle.Danger;
    case "link":
      return ButtonStyle.Link;
    case "primary":
    default:
      return ButtonStyle.Primary;
  }
}

function mapTextInputStyle(style?: DiscordModalFieldSpec["style"]) {
  return style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short;
}

function normalizeBlockType(raw: string) {
  const lowered = normalizeLowercaseStringOrEmpty(raw);
  return BLOCK_ALIASES.get(lowered) ?? (lowered as DiscordComponentBlock["type"]);
}

function parseSelectOptions(
  raw: unknown,
  label: string,
): DiscordComponentSelectOption[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be an array`);
  }
  return raw.map((entry, index) => {
    const obj = requireObject(entry, `${label}[${index}]`);
    return {
      label: readString(obj.label, `${label}[${index}].label`),
      value: readString(obj.value, `${label}[${index}].value`),
      description: readOptionalString(obj.description),
      emoji:
        typeof obj.emoji === "object" && obj.emoji && !Array.isArray(obj.emoji)
          ? {
              name: readString(
                (obj.emoji as { name?: unknown }).name,
                `${label}[${index}].emoji.name`,
              ),
              id: readOptionalString((obj.emoji as { id?: unknown }).id),
              animated:
                typeof (obj.emoji as { animated?: unknown }).animated === "boolean"
                  ? (obj.emoji as { animated?: boolean }).animated
                  : undefined,
            }
          : undefined,
      default: typeof obj.default === "boolean" ? obj.default : undefined,
    };
  });
}

function parseButtonSpec(raw: unknown, label: string): DiscordComponentButtonSpec {
  const obj = requireObject(raw, label);
  const style = readOptionalString(obj.style) as DiscordComponentButtonStyle | undefined;
  const url = readOptionalString(obj.url);
  if ((style === "link" || url) && !url) {
    throw new Error(`${label}.url is required for link buttons`);
  }
  return {
    label: readString(obj.label, `${label}.label`),
    style,
    url,
    callbackData: readOptionalString(obj.callbackData),
    emoji:
      typeof obj.emoji === "object" && obj.emoji && !Array.isArray(obj.emoji)
        ? {
            name: readString((obj.emoji as { name?: unknown }).name, `${label}.emoji.name`),
            id: readOptionalString((obj.emoji as { id?: unknown }).id),
            animated:
              typeof (obj.emoji as { animated?: unknown }).animated === "boolean"
                ? (obj.emoji as { animated?: boolean }).animated
                : undefined,
          }
        : undefined,
    disabled: typeof obj.disabled === "boolean" ? obj.disabled : undefined,
    allowedUsers: readOptionalStringArray(obj.allowedUsers, `${label}.allowedUsers`),
  };
}

function parseSelectSpec(raw: unknown, label: string): DiscordComponentSelectSpec {
  const obj = requireObject(raw, label);
  const type = readOptionalString(obj.type) as DiscordComponentSelectType | undefined;
  const allowedTypes: DiscordComponentSelectType[] = [
    "string",
    "user",
    "role",
    "mentionable",
    "channel",
  ];
  if (type && !allowedTypes.includes(type)) {
    throw new Error(`${label}.type must be one of ${allowedTypes.join(", ")}`);
  }
  return {
    type,
    callbackData: readOptionalString(obj.callbackData),
    placeholder: readOptionalString(obj.placeholder),
    minValues: readOptionalNumber(obj.minValues),
    maxValues: readOptionalNumber(obj.maxValues),
    options: parseSelectOptions(obj.options, `${label}.options`),
    allowedUsers: readOptionalStringArray(obj.allowedUsers, `${label}.allowedUsers`),
  };
}

function parseModalField(raw: unknown, label: string, index: number): DiscordModalFieldSpec {
  const obj = requireObject(raw, label);
  const type = normalizeLowercaseStringOrEmpty(
    readString(obj.type, `${label}.type`),
  ) as DiscordComponentModalFieldType;
  const supported: DiscordComponentModalFieldType[] = [
    "text",
    "checkbox",
    "radio",
    "select",
    "role-select",
    "user-select",
  ];
  if (!supported.includes(type)) {
    throw new Error(`${label}.type must be one of ${supported.join(", ")}`);
  }
  const options = parseSelectOptions(obj.options, `${label}.options`);
  if (["checkbox", "radio", "select"].includes(type) && (!options || options.length === 0)) {
    throw new Error(`${label}.options is required for ${type} fields`);
  }
  return {
    type,
    name: normalizeModalFieldName(readOptionalString(obj.name), index),
    label: readString(obj.label, `${label}.label`),
    description: readOptionalString(obj.description),
    placeholder: readOptionalString(obj.placeholder),
    required: typeof obj.required === "boolean" ? obj.required : undefined,
    options,
    minValues: readOptionalNumber(obj.minValues),
    maxValues: readOptionalNumber(obj.maxValues),
    minLength: readOptionalNumber(obj.minLength),
    maxLength: readOptionalNumber(obj.maxLength),
    style: readOptionalString(obj.style) as DiscordModalFieldSpec["style"],
  };
}

function parseComponentBlock(raw: unknown, label: string): DiscordComponentBlock {
  const obj = requireObject(raw, label);
  const typeRaw = normalizeLowercaseStringOrEmpty(readString(obj.type, `${label}.type`));
  const type = normalizeBlockType(typeRaw);
  switch (type) {
    case "text":
      return {
        type: "text",
        text: readString(obj.text, `${label}.text`),
      };
    case "section": {
      const text = readOptionalString(obj.text);
      const textsRaw = obj.texts;
      const texts = Array.isArray(textsRaw)
        ? textsRaw.map((entry, idx) => readString(entry, `${label}.texts[${idx}]`))
        : undefined;
      if (!text && (!texts || texts.length === 0)) {
        throw new Error(`${label}.text or ${label}.texts is required for section blocks`);
      }
      let accessory: DiscordComponentSectionAccessory | undefined;
      if (obj.accessory !== undefined) {
        const accessoryObj = requireObject(obj.accessory, `${label}.accessory`);
        const accessoryType = normalizeLowercaseStringOrEmpty(
          readString(accessoryObj.type, `${label}.accessory.type`),
        );
        if (accessoryType === "thumbnail") {
          accessory = {
            type: "thumbnail",
            url: readString(accessoryObj.url, `${label}.accessory.url`),
          };
        } else if (accessoryType === "button") {
          accessory = {
            type: "button",
            button: parseButtonSpec(accessoryObj.button, `${label}.accessory.button`),
          };
        } else {
          throw new Error(`${label}.accessory.type must be "thumbnail" or "button"`);
        }
      }
      return {
        type: "section",
        text,
        texts,
        accessory,
      };
    }
    case "separator": {
      const spacingRaw = obj.spacing;
      let spacing: DiscordComponentSeparatorSpacing | undefined;
      if (spacingRaw === "small" || spacingRaw === "large") {
        spacing = spacingRaw;
      } else if (spacingRaw === 1 || spacingRaw === 2) {
        spacing = spacingRaw;
      } else if (spacingRaw !== undefined) {
        throw new Error(`${label}.spacing must be "small", "large", 1, or 2`);
      }
      const divider = typeof obj.divider === "boolean" ? obj.divider : undefined;
      return {
        type: "separator",
        spacing,
        divider,
      };
    }
    case "actions": {
      const buttonsRaw = obj.buttons;
      const buttons = Array.isArray(buttonsRaw)
        ? buttonsRaw.map((entry, idx) => parseButtonSpec(entry, `${label}.buttons[${idx}]`))
        : undefined;
      const select = obj.select ? parseSelectSpec(obj.select, `${label}.select`) : undefined;
      if ((!buttons || buttons.length === 0) && !select) {
        throw new Error(`${label} requires buttons or select`);
      }
      if (buttons && select) {
        throw new Error(`${label} cannot include both buttons and select`);
      }
      return {
        type: "actions",
        buttons,
        select,
      };
    }
    case "media-gallery": {
      const itemsRaw = obj.items;
      if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
        throw new Error(`${label}.items must be a non-empty array`);
      }
      const items = itemsRaw.map((entry, idx) => {
        const itemObj = requireObject(entry, `${label}.items[${idx}]`);
        return {
          url: readString(itemObj.url, `${label}.items[${idx}].url`),
          description: readOptionalString(itemObj.description),
          spoiler: typeof itemObj.spoiler === "boolean" ? itemObj.spoiler : undefined,
        };
      });
      return {
        type: "media-gallery",
        items,
      };
    }
    case "file": {
      const file = readString(obj.file, `${label}.file`);
      return {
        type: "file",
        file: normalizeAttachmentRef(file, `${label}.file`),
        spoiler: typeof obj.spoiler === "boolean" ? obj.spoiler : undefined,
      };
    }
    default:
      throw new Error(`${label}.type must be a supported component block`);
  }
}

export function readDiscordComponentSpec(raw: unknown): DiscordComponentMessageSpec | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const obj = requireObject(raw, "components");
  const blocksRaw = obj.blocks;
  const blocks = Array.isArray(blocksRaw)
    ? blocksRaw.map((entry, idx) => parseComponentBlock(entry, `components.blocks[${idx}]`))
    : undefined;
  const modalRaw = obj.modal;
  const reusable = typeof obj.reusable === "boolean" ? obj.reusable : undefined;
  let modal: DiscordModalSpec | undefined;
  if (modalRaw !== undefined) {
    const modalObj = requireObject(modalRaw, "components.modal");
    const fieldsRaw = modalObj.fields;
    if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) {
      throw new Error("components.modal.fields must be a non-empty array");
    }
    if (fieldsRaw.length > 5) {
      throw new Error("components.modal.fields supports up to 5 inputs");
    }
    const fields = fieldsRaw.map((entry, idx) =>
      parseModalField(entry, `components.modal.fields[${idx}]`, idx),
    );
    modal = {
      title: readString(modalObj.title, "components.modal.title"),
      callbackData: readOptionalString(modalObj.callbackData),
      triggerLabel: readOptionalString(modalObj.triggerLabel),
      triggerStyle: readOptionalString(modalObj.triggerStyle) as DiscordComponentButtonStyle,
      allowedUsers: readOptionalStringArray(modalObj.allowedUsers, "components.modal.allowedUsers"),
      fields,
    };
  }
  return {
    text: readOptionalString(obj.text),
    reusable,
    container:
      typeof obj.container === "object" && obj.container && !Array.isArray(obj.container)
        ? {
            accentColor: (obj.container as { accentColor?: unknown }).accentColor as
              | string
              | number
              | undefined,
            spoiler:
              typeof (obj.container as { spoiler?: unknown }).spoiler === "boolean"
                ? ((obj.container as { spoiler?: boolean }).spoiler as boolean)
                : undefined,
          }
        : undefined,
    blocks,
    modal,
  };
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
      entry: {
        id: componentId,
        kind: "select",
        label: params.spec.placeholder ?? "select",
        callbackData: params.spec.callbackData,
        selectType: "string",
        options: options.map((option) => ({ value: option.value, label: option.label })),
        allowedUsers: params.spec.allowedUsers,
      },
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
      entry: {
        id: componentId,
        kind: "select",
        label: params.spec.placeholder ?? "user select",
        callbackData: params.spec.callbackData,
        selectType: "user",
        allowedUsers: params.spec.allowedUsers,
      },
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
      entry: {
        id: componentId,
        kind: "select",
        label: params.spec.placeholder ?? "role select",
        callbackData: params.spec.callbackData,
        selectType: "role",
        allowedUsers: params.spec.allowedUsers,
      },
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
      entry: {
        id: componentId,
        kind: "select",
        label: params.spec.placeholder ?? "mentionable select",
        callbackData: params.spec.callbackData,
        selectType: "mentionable",
        allowedUsers: params.spec.allowedUsers,
      },
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
    entry: {
      id: componentId,
      kind: "select",
      label: params.spec.placeholder ?? "channel select",
      callbackData: params.spec.callbackData,
      selectType: "channel",
      allowedUsers: params.spec.allowedUsers,
    },
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

function createModalFieldComponent(
  field: DiscordModalFieldDefinition,
): TextInput | StringSelectMenu | UserSelectMenu | RoleSelectMenu | CheckboxGroup | RadioGroup {
  if (field.type === "text") {
    class DynamicTextInput extends TextInput {
      customId = field.id;
      style = mapTextInputStyle(field.style);
      placeholder = field.placeholder;
      required = field.required;
      minLength = field.minLength;
      maxLength = field.maxLength;
    }
    return new DynamicTextInput();
  }
  if (field.type === "select") {
    const options = field.options ?? [];
    class DynamicModalSelect extends StringSelectMenu {
      customId = field.id;
      options = options;
      required = field.required;
      minValues = field.minValues;
      maxValues = field.maxValues;
      placeholder = field.placeholder;
    }
    return new DynamicModalSelect();
  }
  if (field.type === "role-select") {
    class DynamicModalRoleSelect extends RoleSelectMenu {
      customId = field.id;
      required = field.required;
      minValues = field.minValues;
      maxValues = field.maxValues;
      placeholder = field.placeholder;
    }
    return new DynamicModalRoleSelect();
  }
  if (field.type === "user-select") {
    class DynamicModalUserSelect extends UserSelectMenu {
      customId = field.id;
      required = field.required;
      minValues = field.minValues;
      maxValues = field.maxValues;
      placeholder = field.placeholder;
    }
    return new DynamicModalUserSelect();
  }
  if (field.type === "checkbox") {
    const options = field.options ?? [];
    class DynamicCheckboxGroup extends CheckboxGroup {
      customId = field.id;
      options = options;
      required = field.required;
      minValues = field.minValues;
      maxValues = field.maxValues;
    }
    return new DynamicCheckboxGroup();
  }
  const options = field.options ?? [];
  class DynamicRadioGroup extends RadioGroup {
    customId = field.id;
    options = options;
    required = field.required;
    minValues = field.minValues;
    maxValues = field.maxValues;
  }
  return new DynamicRadioGroup();
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

export class DiscordFormModal extends ModalBase {
  title: string;
  customId: string;
  components: Array<Label | TextDisplay>;
  customIdParser = parseDiscordModalCustomIdForCarbonImpl;

  constructor(params: { modalId: string; title: string; fields: DiscordModalFieldDefinition[] }) {
    super();
    this.title = params.title;
    this.customId = buildDiscordModalCustomIdImpl(params.modalId);
    this.components = params.fields.map((field) => {
      const component = createModalFieldComponent(field);
      class DynamicLabel extends Label {
        label = field.label;
        description = field.description;
        component = component;
        customId = field.id;
      }
      return new DynamicLabel(component);
    });
  }

  async run(): Promise<void> {
    throw new Error("Modal handler is not registered for dynamic forms");
  }
}

export function createDiscordFormModal(entry: DiscordModalEntry): Modal {
  return new DiscordFormModal({
    modalId: entry.id,
    title: entry.title,
    fields: entry.fields,
  });
}

export function formatDiscordComponentEventText(params: {
  kind: "button" | "select";
  label: string;
  values?: string[];
}): string {
  if (params.kind === "button") {
    return `Clicked "${params.label}".`;
  }
  const values = params.values ?? [];
  if (values.length === 0) {
    return `Updated "${params.label}".`;
  }
  return `Selected ${values.join(", ")} from "${params.label}".`;
}
