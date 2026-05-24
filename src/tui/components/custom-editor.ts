import { Editor, isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";

const KITTY_CSI_U_SUFFIX_REGEX = /^(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d+))?(?::(\d+))?u$/u;
const KITTY_MODIFIERS = {
  alt: 2,
  ctrl: 4,
};
const LOCK_MODIFIER_MASK = 64 + 128;

function decodeAltGrPrintable(data: string): string | undefined {
  if (!data.startsWith("\u001b[")) {
    return undefined;
  }

  const match = data.slice(2).match(KITTY_CSI_U_SUFFIX_REGEX);
  if (!match) {
    return undefined;
  }

  const codepoint = Number.parseInt(match[1] ?? "", 10);
  const baseLayoutKey = match[3] ? Number.parseInt(match[3], 10) : undefined;
  const modifierValue = match[4] ? Number.parseInt(match[4], 10) : 1;
  const modifier = (Number.isFinite(modifierValue) ? modifierValue - 1 : 0) & ~LOCK_MODIFIER_MASK;

  if (modifier !== (KITTY_MODIFIERS.alt | KITTY_MODIFIERS.ctrl)) {
    return undefined;
  }
  if (typeof baseLayoutKey !== "number" || baseLayoutKey === codepoint) {
    return undefined;
  }
  if (!Number.isFinite(codepoint) || codepoint < 32) {
    return undefined;
  }

  try {
    return String.fromCodePoint(codepoint);
  } catch {
    return undefined;
  }
}

export class CustomEditor extends Editor {
  onEscape?: () => void;
  onCtrlC?: () => void;
  onCtrlD?: () => void;
  onCtrlG?: () => void;
  onCtrlL?: () => void;
  onCtrlO?: () => void;
  onCtrlP?: () => void;
  onCtrlT?: () => void;
  onShiftTab?: () => void;
  onAltEnter?: () => void;
  onAltUp?: () => void;

  override handleInput(data: string): void {
    if (isKeyRelease(data)) {
      return;
    }

    if (matchesKey(data, Key.alt("enter")) && this.onAltEnter) {
      this.onAltEnter();
      return;
    }
    if (matchesKey(data, Key.alt("up")) && this.onAltUp) {
      this.onAltUp();
      return;
    }
    if (matchesKey(data, Key.ctrl("l")) && this.onCtrlL) {
      this.onCtrlL();
      return;
    }
    if (matchesKey(data, Key.ctrl("o")) && this.onCtrlO) {
      this.onCtrlO();
      return;
    }
    if (matchesKey(data, Key.ctrl("p")) && this.onCtrlP) {
      this.onCtrlP();
      return;
    }
    if (matchesKey(data, Key.ctrl("g")) && this.onCtrlG) {
      this.onCtrlG();
      return;
    }
    if (matchesKey(data, Key.ctrl("t")) && this.onCtrlT) {
      this.onCtrlT();
      return;
    }
    if (matchesKey(data, Key.shift("tab")) && this.onShiftTab) {
      this.onShiftTab();
      return;
    }
    if (matchesKey(data, Key.escape) && this.onEscape && !this.isShowingAutocomplete()) {
      this.onEscape();
      return;
    }
    if (matchesKey(data, Key.ctrl("c")) && this.onCtrlC) {
      this.onCtrlC();
      return;
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      if (this.getText().length === 0 && this.onCtrlD) {
        this.onCtrlD();
      }
      return;
    }

    const altGrPrintable = decodeAltGrPrintable(data);
    if (altGrPrintable !== undefined) {
      super.handleInput(altGrPrintable);
      return;
    }

    super.handleInput(data);
  }
}
