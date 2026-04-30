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

export class DiscordFormModal extends ModalBase {
  title: string;
  customId: string;
  components: Array<Label | TextDisplay>;
  customIdParser = parseDiscordModalCustomIdForInteractionImpl;

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
