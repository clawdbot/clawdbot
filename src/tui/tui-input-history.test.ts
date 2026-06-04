// Covers TUI input history navigation and persistence behavior.
import { describe, expect, it } from "vitest";
import { createSubmitHarness } from "./tui-submit-test-helpers.js";

describe("createEditorSubmitHandler", () => {
  it("adds submitted messages to editor history", () => {
    const { editor, onSubmit } = createSubmitHarness();

    onSubmit("hello world");

    expect(editor.setText).toHaveBeenCalledWith("");
    expect(editor.addToHistory).toHaveBeenCalledWith("hello world");
  });

  it("trims input before adding to history", () => {
    const { editor, onSubmit } = createSubmitHarness();

    onSubmit("   hi   ");

    expect(editor.addToHistory).toHaveBeenCalledWith("hi");
  });

  it.each(["", "   "])("does not add blank submissions to history", (text) => {
    const { editor, onSubmit } = createSubmitHarness();

    onSubmit(text);

    expect(editor.addToHistory).not.toHaveBeenCalled();
  });

  it("routes slash commands to handleCommand", () => {
    const { editor, handleCommand, sendMessage, onSubmit } = createSubmitHarness();

    onSubmit("/models");

    expect(editor.addToHistory).toHaveBeenCalledWith("/models");
    expect(handleCommand).toHaveBeenCalledWith("/models");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("routes normal messages to sendMessage", () => {
    const { editor, handleCommand, sendMessage, onSubmit } = createSubmitHarness();

    onSubmit("hello");

    expect(editor.addToHistory).toHaveBeenCalledWith("hello");
    expect(sendMessage).toHaveBeenCalledWith("hello");
    expect(handleCommand).not.toHaveBeenCalled();
  });

  it("routes bang-prefixed lines to handleBangLine", () => {
    const { handleBangLine, onSubmit } = createSubmitHarness();

    onSubmit("!ls");

    expect(handleBangLine).toHaveBeenCalledWith("!ls");
  });
});
