import type { DesktopConnectionHandle } from "./desktop-client.ts";

/**
 * Mobile browsers only report composed text through an input's value, so the desktop document
 * keeps a padded sentinel in the field and derives key events from how that value changed.
 */
const MOBILE_KEYBOARD_SENTINEL = "________________";

type MobileKeyboardOptions = {
  connection: () => DesktopConnectionHandle | null;
  controlling: () => boolean;
  input: () => HTMLTextAreaElement | null | undefined;
};

/** Bridges the desktop document's hidden textarea to the remote desktop's keyboard. */
export class DesktopMobileKeyboard {
  /** The document view renders this so the field always holds deletable padding. */
  value = MOBILE_KEYBOARD_SENTINEL;

  constructor(private readonly options: MobileKeyboardOptions) {}

  focus(): void {
    const input = this.options.input();
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(input.value.length, input.value.length);
  }

  reset(input?: HTMLTextAreaElement): void {
    this.value = MOBILE_KEYBOARD_SENTINEL;
    const target = input ?? this.options.input();
    if (target) {
      target.value = MOBILE_KEYBOARD_SENTINEL;
    }
  }

  handleKeyboardEvent(event: KeyboardEvent): void {
    const connection = this.options.connection();
    if (!this.options.controlling() || !connection) {
      return;
    }
    connection.sendKeyboardEvent(event);
    event.preventDefault();
  }

  handleInput(event: InputEvent): void {
    const input = event.currentTarget as HTMLTextAreaElement;
    if (!this.options.controlling()) {
      this.reset(input);
      return;
    }
    const nextValue = input.value;
    const connection = this.options.connection();
    let prefixLength = 0;
    for (const character of this.value) {
      if (!nextValue.startsWith(character, prefixLength)) {
        break;
      }
      prefixLength += character.length;
    }
    // DOM offsets use UTF-16; a removed supplementary character is one key action.
    for (
      let remaining = Array.from(this.value.slice(prefixLength)).length;
      remaining > 0;
      remaining -= 1
    ) {
      connection?.sendBackspace();
    }
    connection?.sendText(nextValue.slice(prefixLength));
    // Refill once the field drifts outside the range that keeps further deletes reportable.
    if (nextValue.length < 1 || nextValue.length > MOBILE_KEYBOARD_SENTINEL.length * 2) {
      this.reset(input);
      return;
    }
    this.value = nextValue;
  }
}
