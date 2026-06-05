// Custom editor tests cover TUI editor key handling and cursor behavior.
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editorTheme } from "../theme/theme.js";
import { CustomEditor } from "./custom-editor.js";

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
});
