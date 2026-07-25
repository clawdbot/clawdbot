// Custom editor tests cover TUI editor key handling and cursor behavior.
import { CombinedAutocompleteProvider, TUI } from "@earendil-works/pi-tui";
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
});
