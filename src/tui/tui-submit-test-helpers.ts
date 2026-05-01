import { vi } from "vitest";
import { createEditorSubmitHandler } from "./tui-submit.js";

type MockFn = ReturnType<typeof vi.fn>;

type SubmitHarness = {
  editor: {
    setText: MockFn;
    addToHistory: MockFn;
  };
  handleCommand: MockFn;
  sendMessage: MockFn;
  handleBangLine: MockFn;
  onSubmit: (text: string) => void;
};

export function createSubmitHarness(): SubmitHarness {
  const editor = {
    setText: vi.fn(),
    addToHistory: vi.fn(),
  };
  const handleCommand = vi.fn();
  const sendMessage = vi.fn();
  const handleBangLine = vi.fn();
  const onSubmit = createEditorSubmitHandler({
    editor,
    handleCommand,
    sendMessage,
    handleBangLine,
  });
  return { editor, handleCommand, sendMessage, handleBangLine, onSubmit };
}
