import {
  buildDiscordModalCustomId as buildDiscordModalCustomIdImpl,
  parseDiscordModalCustomIdForInteraction as parseDiscordModalCustomIdForInteractionImpl,
} from "./component-custom-id.js";
import { mapTextInputStyle } from "./components.parse.js";
import type { DiscordModalEntry, DiscordModalFieldDefinition } from "./components.types.js";
import {
  CheckboxGroup,
  Label,
  Modal,
  RadioGroup,
  RoleSelectMenu,
  StringSelectMenu,
  TextDisplay,
  TextInput,
  UserSelectMenu,
} from "./internal/discord.js";

// Some test-only module graphs partially mock `./internal/discord.js` and can drop `Modal`.
// Keep dynamic form definitions loadable instead of crashing unrelated suites.
const ModalBase: typeof Modal = Modal ?? (function ModalFallback() {} as unknown as typeof Modal);

function createModalFieldComponent(
  field: DiscordModalFieldDefinition,
): TextInput | StringSelectMenu | UserSelectMenu | RoleSelectMenu | CheckboxGroup | RadioGroup {
  if (field.type === "text") {
    class DynamicTextInput extends TextInput {
      customId = field.id;
      override style = mapTextInputStyle(field.style);
      override placeholder = field.placeholder;
      override required = field.required;
      override minLength = field.minLength;
      override maxLength = field.maxLength;
    }
    return new DynamicTextInput();
  }
  if (field.type === "select") {
    const options = field.options ?? [];
    class DynamicModalSelect extends StringSelectMenu {
      customId = field.id;
      override options = options;
      override required = field.required;
      override minValues = field.minValues;
      override maxValues = field.maxValues;
      override placeholder = field.placeholder;
    }
    return new DynamicModalSelect();
  }
  if (field.type === "role-select") {
    class DynamicModalRoleSelect extends RoleSelectMenu {
      customId = field.id;
      override required = field.required;
      override minValues = field.minValues;
      override maxValues = field.maxValues;
      override placeholder = field.placeholder;
    }
    return new DynamicModalRoleSelect();
  }
  if (field.type === "user-select") {
    class DynamicModalUserSelect extends UserSelectMenu {
      customId = field.id;
      override required = field.required;
      override minValues = field.minValues;
      override maxValues = field.maxValues;
      override placeholder = field.placeholder;
    }
    return new DynamicModalUserSelect();
  }
  if (field.type === "checkbox") {
    const options = field.options ?? [];
    class DynamicCheckboxGroup extends CheckboxGroup {
      customId = field.id;
      override options = options;
      override required = field.required;
      override minValues = field.minValues;
      override maxValues = field.maxValues;
    }
    return new DynamicCheckboxGroup();
  }
  const options = field.options ?? [];
  class DynamicRadioGroup extends RadioGroup {
    customId = field.id;
    override options = options;
    override required = field.required;
    override minValues = field.minValues;
    override maxValues = field.maxValues;
  }
  return new DynamicRadioGroup();
}

export class DiscordFormModal extends ModalBase {
  override title: string;
  override customId: string;
  override components: Array<Label | TextDisplay>;
  override customIdParser = parseDiscordModalCustomIdForInteractionImpl;

  constructor(params: { modalId: string; title: string; fields: DiscordModalFieldDefinition[] }) {
    super();
    this.title = params.title;
    this.customId = buildDiscordModalCustomIdImpl(params.modalId);
    this.components = params.fields.map((field) => {
      const component = createModalFieldComponent(field);
      class DynamicLabel extends Label {
        override label = field.label;
        override description = field.description;
        override component = component;
        override customId = field.id;
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
