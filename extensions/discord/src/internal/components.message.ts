import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIChannelSelectComponent,
  type APIComponentInMessageActionRow,
  type APIContainerComponent,
  type APIFileComponent,
  type APIMediaGalleryComponent,
  type APISectionComponent,
  type APISeparatorComponent,
  type APIStringSelectComponent,
  type APITextDisplayComponent,
  type APIThumbnailComponent,
} from "discord-api-types/v10";
import {
  BaseComponent,
  BaseMessageInteractiveComponent,
  clean,
  colorToNumber,
} from "./components.base.js";

abstract class BaseButton extends BaseMessageInteractiveComponent {
  readonly type = ComponentType.Button;
  abstract label: string;
  emoji?: { name: string; id?: string; animated?: boolean };
  style: ButtonStyle = ButtonStyle.Primary;
  disabled = false;
}

export abstract class Button extends BaseButton {
  serialize(): APIButtonComponent {
    return clean({
      type: this.type,
      style: this.style,
      custom_id: this.customId,
      label: this.label,
      emoji: this.emoji,
      disabled: this.disabled || undefined,
    }) as APIButtonComponent;
  }
}

export abstract class LinkButton extends BaseButton {
  customId = "";
  abstract url: string;
  style = ButtonStyle.Link;
  async run(): Promise<never> {
    throw new Error("Link buttons do not run handlers");
  }
  serialize(): APIButtonComponent {
    return clean({
      type: this.type,
      style: this.style,
      label: this.label,
      emoji: this.emoji,
      disabled: this.disabled || undefined,
      url: this.url,
    }) as APIButtonComponent;
  }
}

export abstract class AnySelectMenu extends BaseMessageInteractiveComponent {
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  disabled = false;
  required?: boolean;
  abstract serializeOptions(): Record<string, unknown>;
  serialize() {
    return clean({
      ...this.serializeOptions(),
      custom_id: this.customId,
      placeholder: this.placeholder,
      min_values: this.minValues,
      max_values: this.maxValues,
      disabled: this.disabled || undefined,
      required: this.required,
    });
  }
}

export abstract class StringSelectMenu extends AnySelectMenu {
  readonly type = ComponentType.StringSelect;
  abstract options: APIStringSelectComponent["options"];
  serializeOptions() {
    return { type: this.type, options: this.options };
  }
}

export abstract class UserSelectMenu extends AnySelectMenu {
  readonly type = ComponentType.UserSelect;
  defaultValues?: unknown[];
  serializeOptions() {
    return { type: this.type, default_values: this.defaultValues };
  }
}

export abstract class RoleSelectMenu extends AnySelectMenu {
  readonly type = ComponentType.RoleSelect;
  defaultValues?: unknown[];
  serializeOptions() {
    return { type: this.type, default_values: this.defaultValues };
  }
}

export abstract class MentionableSelectMenu extends AnySelectMenu {
  readonly type = ComponentType.MentionableSelect;
  defaultValues?: unknown[];
  serializeOptions() {
    return { type: this.type, default_values: this.defaultValues };
  }
}

export abstract class ChannelSelectMenu extends AnySelectMenu {
  readonly type = ComponentType.ChannelSelect;
  channelTypes?: APIChannelSelectComponent["channel_types"];
  defaultValues?: unknown[];
  serializeOptions() {
    return {
      type: this.type,
      default_values: this.defaultValues,
      channel_types: this.channelTypes,
    };
  }
}

export class Row<T extends BaseMessageInteractiveComponent> extends BaseComponent {
  readonly type = ComponentType.ActionRow;
  readonly isV2 = false;
  components: T[];
  constructor(components: T[] = []) {
    super();
    this.components = components;
  }
  addComponent(component: T): void {
    this.components.push(component);
  }
  removeComponent(component: T): void {
    this.components = this.components.filter((entry) => entry !== component);
  }
  removeAllComponents(): void {
    this.components = [];
  }
  serialize(): APIActionRowComponent<APIComponentInMessageActionRow> {
    return {
      type: this.type,
      components: this.components.map(
        (entry) => entry.serialize() as APIComponentInMessageActionRow,
      ),
    };
  }
}

export class TextDisplay extends BaseComponent {
  readonly type = ComponentType.TextDisplay;
  readonly isV2 = true;
  constructor(public content?: string) {
    super();
  }
  serialize(): APITextDisplayComponent {
    return clean({ type: this.type, content: this.content }) as APITextDisplayComponent;
  }
}

export class Separator extends BaseComponent {
  readonly type = ComponentType.Separator;
  readonly isV2 = true;
  divider = true;
  spacing: 1 | 2 | "small" | "large" = "small";
  constructor(options?: { spacing?: Separator["spacing"]; divider?: boolean }) {
    super();
    this.spacing = options?.spacing ?? this.spacing;
    this.divider = options?.divider ?? this.divider;
  }
  serialize(): APISeparatorComponent {
    return clean({
      type: this.type,
      divider: this.divider,
      spacing: this.spacing === "large" ? 2 : this.spacing === "small" ? 1 : this.spacing,
    }) as APISeparatorComponent;
  }
}

export class Thumbnail extends BaseComponent {
  readonly type = ComponentType.Thumbnail;
  readonly isV2 = true;
  constructor(public url?: string) {
    super();
  }
  serialize(): APIThumbnailComponent {
    return clean({
      type: this.type,
      media: this.url ? { url: this.url } : undefined,
    }) as APIThumbnailComponent;
  }
}

export class Section extends BaseComponent {
  readonly type = ComponentType.Section;
  readonly isV2 = true;
  constructor(
    public components: TextDisplay[] = [],
    public accessory?: Thumbnail | Button | LinkButton,
  ) {
    super();
  }
  serialize(): APISectionComponent {
    return clean({
      type: this.type,
      components: this.components.map((entry) => entry.serialize()),
      accessory: this.accessory?.serialize(),
    }) as APISectionComponent;
  }
}

export class MediaGallery extends BaseComponent {
  readonly type = ComponentType.MediaGallery;
  readonly isV2 = true;
  constructor(public items: Array<{ url: string; description?: string; spoiler?: boolean }> = []) {
    super();
  }
  serialize(): APIMediaGalleryComponent {
    return {
      type: this.type,
      items: this.items.map((entry) => ({
        media: { url: entry.url },
        description: entry.description,
        spoiler: entry.spoiler,
      })),
    };
  }
}

export class File extends BaseComponent {
  readonly type = ComponentType.File;
  readonly isV2 = true;
  constructor(
    public file?: `attachment://${string}`,
    public spoiler = false,
  ) {
    super();
  }
  serialize(): APIFileComponent {
    return clean({
      type: this.type,
      file: this.file ? { url: this.file } : undefined,
      spoiler: this.spoiler || undefined,
    }) as APIFileComponent;
  }
}

export class Container extends BaseComponent {
  readonly type = ComponentType.Container;
  readonly isV2 = true;
  components: Array<
    Row<BaseMessageInteractiveComponent> | TextDisplay | Section | MediaGallery | Separator | File
  >;
  accentColor?: string | number;
  spoiler = false;
  constructor(
    components: Container["components"] = [],
    options?: { accentColor?: string | number; spoiler?: boolean },
  ) {
    super();
    this.components = components;
    this.accentColor = options?.accentColor;
    this.spoiler = options?.spoiler ?? false;
  }
  serialize(): APIContainerComponent {
    return clean({
      type: this.type,
      components: this.components.map((entry) => entry.serialize()),
      accent_color: colorToNumber(this.accentColor),
      spoiler: this.spoiler || undefined,
    }) as APIContainerComponent;
  }
}
