import { html } from "lit";
import { guard } from "lit/directives/guard.js";
import { ifDefined } from "lit/directives/if-defined.js";
import { live } from "lit/directives/live.js";
import { ref } from "lit/directives/ref.js";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { adjustTextareaHeight, focusComposerFromChrome } from "./chat-composer-dom.ts";
import {
  ensureChatComposerPickerDismissal,
  handleChatComposerDropdownShow,
  markPointerOpenedChatComposerDropdown,
  restorePointerOpenedChatComposerTrigger,
} from "./chat-picker-overlay.ts";

type ComposerEditorOptions = {
  value: string;
  textareaRef?: (element?: Element) => void;
  className?: string;
  autofocus?: boolean;
  disabled: boolean;
  readonly: boolean;
  placeholder: string;
  label: string;
  menuVisible: boolean;
  menuListboxId: string;
  activeMenuOptionId: string | null;
  describedBy: string;
  keyShortcuts: string;
  isComposing: () => boolean;
  onComposingChange: (composing: boolean, target: HTMLTextAreaElement) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onBeforeInput?: (event: InputEvent) => void;
  onInput: (event: InputEvent, target: HTMLTextAreaElement) => void;
  onSelectionChange: (event: Event, target: HTMLTextAreaElement) => void;
  onCompositionEnd?: (event: CompositionEvent, target: HTMLTextAreaElement) => void;
  onBlur?: (event: FocusEvent, target: HTMLTextAreaElement) => void;
  onPaste?: (event: ClipboardEvent) => void;
};

function composerEventTextarea(event: Event): HTMLTextAreaElement {
  if (!(event.target instanceof HTMLTextAreaElement)) {
    throw new TypeError("Composer editor event target must be a textarea");
  }
  return event.target;
}

export function renderComposerEditor(options: ComposerEditorOptions) {
  if (options.menuVisible) {
    ensureChatComposerPickerDismissal();
  }
  const selectionChanged = (event: Event) => {
    options.onSelectionChange(event, composerEventTextarea(event));
  };
  return html`
    <textarea
      ${ref(options.textareaRef)}
      class=${ifDefined(options.className)}
      rows="1"
      ?autofocus=${options.autofocus}
      ?disabled=${options.disabled}
      ?readonly=${options.readonly}
      placeholder=${options.placeholder}
      aria-label=${options.label}
      .value=${guard([options.value], () => live(options.value))}
      dir=${detectTextDirection(options.value)}
      aria-autocomplete="list"
      aria-controls=${ifDefined(options.menuVisible ? options.menuListboxId : undefined)}
      aria-expanded=${ifDefined(options.menuVisible ? "true" : undefined)}
      aria-activedescendant=${ifDefined(options.activeMenuOptionId ?? undefined)}
      aria-describedby=${options.describedBy}
      aria-keyshortcuts=${options.keyShortcuts}
      @keydown=${(event: KeyboardEvent) => {
        if (!options.isComposing() && !event.isComposing && event.keyCode !== 229) {
          options.onKeyDown(event);
        }
      }}
      @beforeinput=${(event: InputEvent) => options.onBeforeInput?.(event)}
      @input=${(event: InputEvent) => {
        const target = composerEventTextarea(event);
        adjustTextareaHeight(target);
        options.onInput(event, target);
      }}
      @select=${selectionChanged}
      @focus=${selectionChanged}
      @pointerup=${selectionChanged}
      @compositionstart=${(event: CompositionEvent) => {
        options.onComposingChange(true, composerEventTextarea(event));
      }}
      @compositionend=${(event: CompositionEvent) => {
        const target = composerEventTextarea(event);
        options.onComposingChange(false, target);
        options.onCompositionEnd?.(event, target);
      }}
      @blur=${(event: FocusEvent) => {
        const target = composerEventTextarea(event);
        options.onComposingChange(false, target);
        options.onBlur?.(event, target);
      }}
      @paste=${(event: ClipboardEvent) => options.onPaste?.(event)}
    ></textarea>
  `;
}

export function createComposerInputHandlers(options: {
  canFocus: () => boolean;
  onDismissInvocations: () => void;
}) {
  return {
    dropdownShow: handleChatComposerDropdownShow,
    dropdownAfterShow: restorePointerOpenedChatComposerTrigger,
    dismissInvocations: options.onDismissInvocations,
    click: (event: MouseEvent) => focusComposerFromChrome(event, options.canFocus()),
    pointerDown: (event: PointerEvent) => {
      markPointerOpenedChatComposerDropdown(event);
      focusComposerFromChrome(event, options.canFocus());
    },
  };
}
