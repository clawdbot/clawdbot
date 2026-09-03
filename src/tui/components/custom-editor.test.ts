// Custom editor tests cover TUI editor key handling and cursor behavior.
import { CombinedAutocompleteProvider, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlashCommands, shouldSubmitExactArgumentCompletion } from "../commands.js";
import { editorTheme } from "../theme/theme.js";
import { CustomEditor } from "./custom-editor.js";

function createAutocompleteEditor() {
  const tui = { requestRender: vi.fn() } as unknown as TUI;
  const editor = new CustomEditor(tui, editorTheme);
  const commands = getSlashCommands();
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, process.cwd()));
  editor.shouldSubmitAutocomplete = (text) => shouldSubmitExactArgumentCompletion(text, commands);
  return editor;
}

async function typeText(editor: CustomEditor, text: string) {
  for (const character of text) {
    editor.handleInput(character);
  }
  await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
}

describe("CustomEditor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { name: "Kitty Shift+Enter", input: "\u001b[13;2u" },
    { name: "Ctrl+J", input: "\n" },
  ])("inserts a newline without submitting on $name", ({ input }) => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    editor.setText("first line");

    editor.handleInput(input);

    expect(editor.getText()).toBe("first line\n");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("routes alt+enter to the follow-up handler", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const onAltEnter = vi.fn();
    editor.onAltEnter = onAltEnter;

    editor.handleInput("\u001b\r");

    expect(onAltEnter).toHaveBeenCalledTimes(1);
  });

  it("routes alt+up to the dequeue handler", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const onAltUp = vi.fn();
    editor.onAltUp = onAltUp;

    editor.handleInput("\u001bp");

    expect(onAltUp).toHaveBeenCalledTimes(1);
  });

  it("uses Ctrl+D to delete the character after a nonempty input cursor", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const onCtrlD = vi.fn();
    editor.onCtrlD = onCtrlD;
    editor.setText("keepXword");

    for (let index = 0; index < 5; index += 1) {
      editor.handleInput("\u001b[D");
    }
    editor.handleInput("\u0004");

    expect(editor.getText()).toBe("keepword");
    expect(onCtrlD).not.toHaveBeenCalled();
  });

  it("uses Ctrl+D to request exit only when the editor is empty", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const onCtrlD = vi.fn();
    editor.onCtrlD = onCtrlD;

    editor.handleInput("\u0004");

    expect(onCtrlD).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("");
  });

  it("uses Ctrl+D to join multiline input at the end of a nonempty line", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const onCtrlD = vi.fn();
    editor.onCtrlD = onCtrlD;
    editor.setText("first\nsecond");

    editor.handleInput("\u001b[A");
    editor.handleInput("\u0004");

    expect(editor.getText()).toBe("firstsecond");
    expect(onCtrlD).not.toHaveBeenCalled();
  });

  it("uses Ctrl+D to delete one complete grapheme from nonempty input", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const onCtrlD = vi.fn();
    editor.onCtrlD = onCtrlD;
    editor.setText("a👨‍👩‍👧‍👦b");

    editor.handleInput("\u001b[D");
    editor.handleInput("\u001b[D");
    editor.handleInput("\u0004");

    expect(editor.getText()).toBe("ab");
    expect(onCtrlD).not.toHaveBeenCalled();
  });

  it("does not exit or change nonempty input when Ctrl+D is at its final cursor", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const onCtrlD = vi.fn();
    editor.onCtrlD = onCtrlD;
    editor.setText("keepword");

    editor.handleInput("\u0004");

    expect(editor.getText()).toBe("keepword");
    expect(onCtrlD).not.toHaveBeenCalled();
  });

  it("uses Ctrl+D to edit recalled input history without requesting exit", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const onCtrlD = vi.fn();
    editor.onCtrlD = onCtrlD;
    editor.addToHistory("history");

    editor.handleInput("\u001b[A");
    editor.handleInput("\u0001");
    editor.handleInput("\u0004");

    expect(editor.getText()).toBe("istory");
    expect(onCtrlD).not.toHaveBeenCalled();
  });

  it("inserts German AltGr printable Kitty CSI-u input", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);

    editor.handleInput("\u001b[64::113;7u");
    editor.handleInput("\u001b[8364::101;7u");

    expect(editor.getText()).toBe("@€");
  });

  it("does not insert ordinary Alt-modified Kitty CSI-u input", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);

    editor.handleInput("\u001b[113;3u");

    expect(editor.getText()).toBe("");
  });

  it("ignores printable Kitty key release events", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);

    editor.handleInput("\u001b[214;1u");
    editor.handleInput("\u001b[214;1:3u");

    expect(editor.getText()).toBe("Ö");
  });

  it("submits an exact sole argument completion with one Enter", async () => {
    const editor = createAutocompleteEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    await typeText(editor, "/think high");

    editor.handleInput("\r");

    expect(onSubmit).toHaveBeenCalledWith("/think high");
    expect(editor.getText()).toBe("");
  });

  it("keeps Enter as completion acceptance when multiple arguments match", async () => {
    const editor = createAutocompleteEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    await typeText(editor, "/fast o");

    editor.handleInput("\r");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("/fast on");
  });

  it("keeps commands without argument completions on one-Enter submit", async () => {
    const editor = createAutocompleteEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    await typeText(editor, "/help");

    editor.handleInput("\r");

    expect(onSubmit).toHaveBeenCalledWith("/help");
  });

  it.each(["  !cmd", "  !cmd\n", "!cmd\n", "\n!cmd\n"])(
    "preserves %j when trimming would create executable bang input",
    (input) => {
      const tui = { requestRender: vi.fn() } as unknown as TUI;
      const editor = new CustomEditor(tui, editorTheme);
      const onSubmit = vi.fn();
      editor.onSubmit = onSubmit;
      editor.setText(input);

      editor.handleInput("\r");

      expect(onSubmit).toHaveBeenCalledExactlyOnceWith(input);
      expect(editor.getText()).toBe("");
    },
  );

  it("leaves harmless bang-prefixed multiline chat on pi-tui's normal submit path", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    editor.setText(" \n!cmd\nnotes");

    editor.handleInput("\r");

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("!cmd\nnotes");
    expect(editor.getText()).toBe("");
  });

  it("does not expand stored paste text for ordinary input", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    editor.setText("draft");
    const getExpandedText = vi.spyOn(editor, "getExpandedText");

    editor.handleInput("x");

    expect(getExpandedText).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("draftx");
  });

  it("keeps pi-tui trimming for ordinary submissions", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    editor.setText("  ordinary message  ");

    editor.handleInput("\r");

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("ordinary message");
  });
});
