import { describe, expect, it, vi } from "vitest";

import { createEditorSubmitHandler } from "./tui.js";

describe("createEditorSubmitHandler", () => {
  it("adds submitted messages to editor history", () => {
    const editor = {
      setText: vi.fn(),
      addToHistory: vi.fn(),
    };

    const handler = createEditorSubmitHandler({
      editor,
      handleCommand: vi.fn(),
      sendMessage: vi.fn(),
      handleBangLine: vi.fn(),
    });

    handler("hello world");

    expect(editor.setText).toHaveBeenCalledWith("");
    expect(editor.addToHistory).toHaveBeenCalledWith("hello world");
  });

  it("trims input before adding to history", () => {
    const editor = {
      setText: vi.fn(),
      addToHistory: vi.fn(),
    };

    const handler = createEditorSubmitHandler({
      editor,
      handleCommand: vi.fn(),
      sendMessage: vi.fn(),
      handleBangLine: vi.fn(),
    });

    handler("   hi   ");

    expect(editor.addToHistory).toHaveBeenCalledWith("hi");
  });

  it("does not add empty-string submissions to history", () => {
    const editor = {
      setText: vi.fn(),
      addToHistory: vi.fn(),
    };

    const handler = createEditorSubmitHandler({
      editor,
      handleCommand: vi.fn(),
      sendMessage: vi.fn(),
      handleBangLine: vi.fn(),
    });

    handler("");

    expect(editor.addToHistory).not.toHaveBeenCalled();
  });

  it("routes slash commands to handleCommand", () => {
    const editor = {
      setText: vi.fn(),
      addToHistory: vi.fn(),
    };
    const handleCommand = vi.fn();
    const sendMessage = vi.fn();

    const handler = createEditorSubmitHandler({
      editor,
      handleCommand,
      sendMessage,
      handleBangLine: vi.fn(),
    });

    handler("/models");

    expect(editor.addToHistory).toHaveBeenCalledWith("/models");
    expect(handleCommand).toHaveBeenCalledWith("/models");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("routes normal messages to sendMessage", () => {
    const editor = {
      setText: vi.fn(),
      addToHistory: vi.fn(),
    };
    const handleCommand = vi.fn();
    const sendMessage = vi.fn();

    const handler = createEditorSubmitHandler({
      editor,
      handleCommand,
      sendMessage,
      handleBangLine: vi.fn(),
    });

    handler("hello");

    expect(editor.addToHistory).toHaveBeenCalledWith("hello");
    expect(sendMessage).toHaveBeenCalledWith("hello");
    expect(handleCommand).not.toHaveBeenCalled();
  });

  it("routes bang-prefixed lines to handleBangLine", () => {
    const editor = {
      setText: vi.fn(),
      addToHistory: vi.fn(),
    };
    const handleBangLine = vi.fn();

    const handler = createEditorSubmitHandler({
      editor,
      handleCommand: vi.fn(),
      sendMessage: vi.fn(),
      handleBangLine,
    });

    handler("!ls");

    expect(handleBangLine).toHaveBeenCalledWith("!ls");
  });

  it("treats a lone ! as a normal message", () => {
    const editor = {
      setText: vi.fn(),
      addToHistory: vi.fn(),
    };
    const sendMessage = vi.fn();

    const handler = createEditorSubmitHandler({
      editor,
      handleCommand: vi.fn(),
      sendMessage,
      handleBangLine: vi.fn(),
    });

    handler("!");

    expect(sendMessage).toHaveBeenCalledWith("!");
  });
});
