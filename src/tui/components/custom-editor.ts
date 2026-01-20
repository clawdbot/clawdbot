import {
  Editor,
  Key,
  matchesKey,
  type EditorOptions,
  type EditorTheme,
  type TUI,
} from "@mariozechner/pi-tui";

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

  constructor(tui: TUI, theme: EditorTheme, options?: EditorOptions);
  constructor(theme: EditorTheme, options?: EditorOptions);
  constructor(
    tuiOrTheme: TUI | EditorTheme,
    themeOrOptions?: EditorTheme | EditorOptions,
    options?: EditorOptions,
  ) {
    const hasTui = typeof (tuiOrTheme as TUI).terminal !== "undefined";
    const theme = hasTui ? (themeOrOptions as EditorTheme) : (tuiOrTheme as EditorTheme);
    const resolvedOptions = hasTui ? options : (themeOrOptions as EditorOptions | undefined);
    const useTuiArg = hasTui && Editor.length >= 2;
    const baseArgs = (useTuiArg
      ? [tuiOrTheme, theme, resolvedOptions]
      : [theme, resolvedOptions]) as unknown as ConstructorParameters<typeof Editor>;

    super(...baseArgs);

    if (hasTui && !useTuiArg) {
      (this as unknown as { tui?: TUI }).tui = tuiOrTheme as TUI;
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.alt("enter")) && this.onAltEnter) {
      this.onAltEnter();
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
    super.handleInput(data);
  }
}
