// Provides test helpers for TUI submit handler scenarios.
import { vi } from "vitest";
import { createEditorSubmitHandler } from "./tui-submit.js";

// Test harness for submit-handler specs without constructing a full TUI.
type MockFn = ReturnType<typeof vi.fn>;

type SubmitHarness = {
  editor: {
    setText: MockFn;
    addToHistory: MockFn;
  };
  handleCommand: MockFn;
  sendMessage: MockFn;
  handleBangLine: MockFn;
  canSubmitMessage: MockFn;
  onBlockedMessageSubmit: MockFn;
  onSubmit: (text: string) => void;
};

/** Creates editor/command/message mocks wired to the real submit handler. */
export function createSubmitHarness(params?: {
  canSubmitMessage?: (value: string) => boolean;
}): SubmitHarness {
  const editor = {
    setText: vi.fn(),
    addToHistory: vi.fn(),
  };
  const handleCommand = vi.fn();
  const sendMessage = vi.fn();
  const handleBangLine = vi.fn();
  const canSubmitMessage = vi.fn(params?.canSubmitMessage ?? (() => true));
  const onBlockedMessageSubmit = vi.fn();
  const onSubmit = createEditorSubmitHandler({
    editor,
    handleCommand,
    sendMessage,
    handleBangLine,
    canSubmitMessage,
    onBlockedMessageSubmit,
  });
  return {
    editor,
    handleCommand,
    sendMessage,
    handleBangLine,
    canSubmitMessage,
    onBlockedMessageSubmit,
    onSubmit,
  };
}
