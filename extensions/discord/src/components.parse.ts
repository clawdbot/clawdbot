import { ButtonStyle, TextInputStyle } from "discord-api-types/v10";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type {
  DiscordComponentBlock,
  DiscordComponentButtonSpec,
  DiscordComponentButtonStyle,
  DiscordComponentMessageSpec,
  DiscordComponentModalFieldType,
  DiscordComponentSectionAccessory,
  DiscordComponentSelectOption,
  DiscordComponentSelectSpec,
  DiscordComponentSelectType,
  DiscordModalFieldSpec,
  DiscordModalSpec,
} from "./components.types.js";

export const DISCORD_COMPONENT_ATTACHMENT_PREFIX = "attachment://";

type DiscordComponentSeparatorSpacing = "small" | "large" | 1 | 2;

const BLOCK_ALIASES = new Map<string, DiscordComponentBlock["type"]>([
  ["row", "actions"],
  ["action-row", "actions"],
]);

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

function readOptionalEmoji(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as { name?: unknown; id?: unknown; animated?: unknown };
  return {
    name: readString(obj.name, `${label}.name`),
    id: readOptionalString(obj.id),
    animated: typeof obj.animated === "boolean" ? obj.animated : undefined,
  };
}

export function normalizeModalFieldName(value: string | undefined, index: number) {
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

export function mapButtonStyle(style?: DiscordComponentButtonStyle): ButtonStyle {
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

export function mapTextInputStyle(style?: DiscordModalFieldSpec["style"]) {
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
      emoji: readOptionalEmoji(obj.emoji, `${label}[${index}].emoji`),
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
    emoji: readOptionalEmoji(obj.emoji, `${label}.emoji`),
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
