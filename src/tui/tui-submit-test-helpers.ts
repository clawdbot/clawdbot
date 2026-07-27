// Provides test helpers for TUI submit handler scenarios.
import { vi } from "vitest";
import type { TuiChatSubmitAdmission } from "./tui-submit-state.js";
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
  admitMessage: MockFn;
  onBlockedMessageSubmit: MockFn;
  onSubmitError: MockFn;
  onSubmit: (text: string) => void;
};

/** Creates editor/command/message mocks wired to the real submit handler. */
export function createSubmitHarness(params?: {
  admitMessage?: (value: string) => TuiChatSubmitAdmission;
}): SubmitHarness {
  const editor = {
    setText: vi.fn(),
    addToHistory: vi.fn(),
  };
  const handleCommand = vi.fn();
  const sendMessage = vi.fn();
  const handleBangLine = vi.fn();
  const admitMessage = vi.fn(params?.admitMessage ?? (() => "allowed" as const));
  const onBlockedMessageSubmit = vi.fn();
  const onSubmitError = vi.fn();
  const onSubmit = createEditorSubmitHandler({
    editor,
    handleCommand,
    sendMessage,
    handleBangLine,
    onSubmitError,
    admitMessage,
    onBlockedMessageSubmit,
  });
  return {
    editor,
    handleCommand,
    sendMessage,
    handleBangLine,
    admitMessage,
    onBlockedMessageSubmit,
    onSubmitError,
    onSubmit,
  };
}
