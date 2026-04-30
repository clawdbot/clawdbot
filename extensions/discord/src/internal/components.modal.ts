import { ComponentType, TextInputStyle, type APITextInputComponent } from "discord-api-types/v10";
import { BaseModalComponent, clean, parseCustomId, type ComponentData } from "./components.base.js";
import { AnySelectMenu, TextDisplay } from "./components.message.js";

export abstract class TextInput extends BaseModalComponent {
  readonly type = ComponentType.TextInput;
  customIdParser = parseCustomId;
  style: TextInputStyle = TextInputStyle.Short;
  minLength?: number;
  maxLength?: number;
  required?: boolean;
  value?: string;
  placeholder?: string;
  serialize(): APITextInputComponent {
    return clean({
      type: this.type,
      custom_id: this.customId,
      style: this.style,
      min_length: this.minLength,
      max_length: this.maxLength,
      required: this.required,
      value: this.value,
      placeholder: this.placeholder,
    }) as APITextInputComponent;
  }
}

export abstract class CheckboxGroup extends BaseModalComponent {
  readonly type = 22;
  options: Array<{ value: string; label: string; description?: string; default?: boolean }> = [];
  required?: boolean;
  minValues?: number;
  maxValues?: number;
  serialize() {
    return clean({
      type: this.type,
      custom_id: this.customId,
      options: this.options,
      required: this.required,
      min_values: this.minValues,
      max_values: this.maxValues,
    });
  }
}

export abstract class RadioGroup extends BaseModalComponent {
  readonly type = 21;
  options: Array<{ value: string; label: string; description?: string; default?: boolean }> = [];
  required?: boolean;
  minValues?: number;
  maxValues?: number;
  serialize() {
    return clean({
      type: this.type,
      custom_id: this.customId,
      options: this.options,
      required: this.required,
      min_values: this.minValues,
      max_values: this.maxValues,
    });
  }
}

export abstract class Label extends BaseModalComponent {
  readonly type = ComponentType.Label;
  abstract label: string;
  description?: string;
  customId = "";
  constructor(public component?: TextInput | AnySelectMenu | CheckboxGroup | RadioGroup) {
    super();
  }
  serialize() {
    return clean({
      type: this.type,
      label: this.label,
      description: this.description,
      component: this.component?.serialize(),
    });
  }
}

export abstract class Modal {
  abstract title: string;
  components: Array<Label | TextDisplay> = [];
  abstract customId: string;
  customIdParser = parseCustomId;
  abstract run(interaction: unknown, data: ComponentData): unknown;
  serialize() {
    return {
      title: this.title,
      custom_id: this.customId,
      components: this.components.map((entry) => entry.serialize()),
    };
  }
}
