// Covers TUI submit handler behavior for chat input and slash commands.
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { CustomEditor } from "./components/custom-editor.js";
import { editorTheme } from "./theme/theme.js";
import { createSubmitHarness } from "./tui-submit-test-helpers.js";
import {
  createEditorSubmitHandler,
  createSubmitBurstCoalescer,
  shouldEnableWindowsGitBashPasteFallback,
} from "./tui-submit.js";

function createRealEditorSubmitHarness(
  admitMessage?: NonNullable<Parameters<typeof createEditorSubmitHandler>[0]["admitMessage"]>,
) {
  const tui = { requestRender: vi.fn() } as unknown as TUI;
  const editor = new CustomEditor(tui, editorTheme);
  const sendMessage = vi.fn();
  const handleBangLine = vi.fn();
  editor.onSubmit = createEditorSubmitHandler({
    editor,
    handleCommand: vi.fn(),
    sendMessage,
    handleBangLine,
    onSubmitError: vi.fn(),
    ...(admitMessage ? { admitMessage } : {}),
  });
  return { editor, sendMessage, handleBangLine };
}

describe("createEditorSubmitHandler", () => {
  it("routes genuine bang input to local shell and history", () => {
    const { editor, sendMessage, handleBangLine } = createRealEditorSubmitHarness();
    editor.setText("!cmd");

    editor.handleInput("\r");

    expect(handleBangLine).toHaveBeenCalledTimes(1);
    expect(handleBangLine).toHaveBeenCalledWith("!cmd");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("");

    editor.handleInput("\u001b[A");

    expect(editor.getText()).toBe("!cmd");
  });

  it("treats a lone ! as a normal message", () => {
    const { sendMessage, handleBangLine, onSubmit } = createSubmitHarness();

    onSubmit("!");

    expect(handleBangLine).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("!");
  });

  it.each([
    { name: "a whitespace-prefixed lone bang", input: "  !", expected: "!" },
    {
      name: "bang-prefixed true multiline chat",
      input: " \n!cmd\nnotes",
      expected: "!cmd\nnotes",
    },
  ])("stores, recalls, and safely resubmits $name", ({ input, expected }) => {
    const { editor, sendMessage, handleBangLine } = createRealEditorSubmitHarness();
    editor.setText(input);

    editor.handleInput("\r");

    expect(handleBangLine).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(expected);
    expect(editor.getText()).toBe("");

    editor.handleInput("\u001b[A");
    expect(editor.getText()).toBe(expected);

    editor.handleInput("\r");

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(2, expected);
    expect(handleBangLine).not.toHaveBeenCalled();
  });

  it.each(["  !cmd", "  !cmd\n", "!cmd\n", "\n!cmd\n"])(
    "keeps %j in chat and omits it from history",
    (input) => {
      const { editor, sendMessage, handleBangLine } = createRealEditorSubmitHarness();
      editor.setText(input);

      editor.handleInput("\r");

      expect(sendMessage).toHaveBeenCalledExactlyOnceWith("!cmd");
      expect(handleBangLine).not.toHaveBeenCalled();
      expect(editor.getText()).toBe("");

      editor.handleInput("\u001b[A");
      expect(editor.getText()).toBe("");

      editor.handleInput("\r");

      expect(sendMessage).toHaveBeenCalledExactlyOnceWith("!cmd");
      expect(handleBangLine).not.toHaveBeenCalled();
    },
  );

  it("preserves whitespace bang routing across a blocked retry", () => {
    const admitMessage = vi
      .fn()
      .mockReturnValueOnce({ status: "blocked", reason: "pending" })
      .mockReturnValueOnce({ status: "allowed" });
    const { editor, sendMessage, handleBangLine } = createRealEditorSubmitHarness(admitMessage);
    editor.setText("  !cmd");

    editor.handleInput("\r");

    expect(editor.getText()).toBe("  !cmd");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(handleBangLine).not.toHaveBeenCalled();

    editor.handleInput("\r");

    expect(admitMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("!cmd");
    expect(handleBangLine).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("");
  });

  it("trims normal messages before sending and adding to history", () => {
    const { editor, sendMessage, onSubmit } = createSubmitHarness();

    onSubmit("  hello  ");

    expect(sendMessage).toHaveBeenCalledWith("hello");
    expect(editor.addToHistory).toHaveBeenCalledWith("hello");
  });

  it("preserves normal message drafts when chat is busy", () => {
    const { editor, sendMessage, handleCommand, handleBangLine, onBlockedMessageSubmit, onSubmit } =
      createSubmitHarness({
        admitMessage: () => ({ status: "blocked", reason: "pending" }),
      });

    onSubmit("  wait, use c++ instead  ");

    expect(editor.setText).toHaveBeenCalledWith("wait, use c++ instead");
    expect(editor.addToHistory).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(handleCommand).not.toHaveBeenCalled();
    expect(handleBangLine).not.toHaveBeenCalled();
    expect(onBlockedMessageSubmit).toHaveBeenCalledWith("wait, use c++ instead", {
      status: "blocked",
      reason: "pending",
    });
  });

  it("passes the submitted text to the busy gate", () => {
    const admitMessage = vi.fn((value: string) =>
      value === "please stop"
        ? ({ status: "allowed" } as const)
        : ({ status: "blocked", reason: "pending" } as const),
    );
    const { sendMessage, onSubmit } = createSubmitHarness({ admitMessage });

    onSubmit("please stop");

    expect(admitMessage).toHaveBeenCalledWith("please stop");
    expect(sendMessage).toHaveBeenCalledWith("please stop");
  });

  it("restores the real editor value after pi-tui clears a busy submit", () => {
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const sendMessage = vi.fn();
    const onBlockedMessageSubmit = vi.fn();
    editor.setText("wait, use c++ instead");
    editor.onSubmit = createEditorSubmitHandler({
      editor,
      handleCommand: vi.fn(),
      sendMessage,
      handleBangLine: vi.fn(),
      onSubmitError: vi.fn(),
      admitMessage: () => ({ status: "blocked", reason: "pending" }),
      onBlockedMessageSubmit,
    });

    editor.handleInput("\r");

    expect(editor.getText()).toBe("wait, use c++ instead");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onBlockedMessageSubmit).toHaveBeenCalledWith("wait, use c++ instead", {
      status: "blocked",
      reason: "pending",
    });
  });

  it("continues to route slash commands while chat is busy", () => {
    const { editor, handleCommand, sendMessage, onBlockedMessageSubmit, onSubmit } =
      createSubmitHarness({
        admitMessage: () => ({ status: "blocked", reason: "pending" }),
      });

    onSubmit("/abort");

    expect(editor.setText).toHaveBeenCalledWith("");
    expect(handleCommand).toHaveBeenCalledWith("/abort");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onBlockedMessageSubmit).not.toHaveBeenCalled();
  });

  it("preserves internal newlines for multiline messages", () => {
    const { editor, handleCommand, sendMessage, handleBangLine, onSubmit } = createSubmitHarness();

    onSubmit("Line 1\nLine 2\nLine 3");

    expect(sendMessage).toHaveBeenCalledWith("Line 1\nLine 2\nLine 3");
    expect(editor.addToHistory).toHaveBeenCalledWith("Line 1\nLine 2\nLine 3");
    expect(handleCommand).not.toHaveBeenCalled();
    expect(handleBangLine).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a slash command", input: "/exit\npasted notes" },
    { name: "a local shell command", input: "!touch pasted-file\npasted notes" },
    { name: "a whitespace-prefixed slash command", input: "  /abort\npasted notes" },
  ])("treats a complete multiline paste beginning with $name as chat", ({ input }) => {
    const { handleCommand, sendMessage, handleBangLine, onSubmit } = createSubmitHarness();

    onSubmit(input);

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(input.trim());
    expect(handleCommand).not.toHaveBeenCalled();
    expect(handleBangLine).not.toHaveBeenCalled();
  });

  it.each([
    ["local shell", "!false", "handleBangLine"],
    ["command", "/broken", "handleCommand"],
    ["message", "hello", "sendMessage"],
  ] as const)("reports rejected %s handlers", async (action, input, handler) => {
    const harness = createSubmitHarness();
    harness[handler].mockRejectedValueOnce(new Error("gateway unavailable"));

    harness.onSubmit(input);
    await Promise.resolve();

    expect(harness.onSubmitError).toHaveBeenCalledWith(action, expect.any(Error));
  });

  it("reports synchronous submit handler failures", () => {
    const harness = createSubmitHarness();
    harness.handleCommand.mockImplementationOnce(() => {
      throw new Error("command exploded");
    });

    expect(() => harness.onSubmit("/broken")).not.toThrow();
    expect(harness.onSubmitError).toHaveBeenCalledWith("command", expect.any(Error));
  });
});

describe("createSubmitBurstCoalescer", () => {
  it("coalesces rapid single-line submits into one multiline submit when enabled", () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    let now = 1_000;
    const submitBurst = createSubmitBurstCoalescer({
      submit,
      enabled: true,
      burstWindowMs: 50,
      now: () => now,
    });

    submitBurst("Line 1");
    now += 10;
    submitBurst("Line 2");
    now += 10;
    submitBurst("Line 3");

    expect(submit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("Line 1\nLine 2\nLine 3");
    vi.useRealTimers();
  });

  it("preserves a newer real editor draft when a buffered message flushes", () => {
    vi.useFakeTimers();
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const sendMessage = vi.fn();
    const submit = createEditorSubmitHandler({
      editor,
      handleCommand: vi.fn(),
      sendMessage,
      handleBangLine: vi.fn(),
      onSubmitError: vi.fn(),
    });
    editor.onSubmit = createSubmitBurstCoalescer({
      submit,
      enabled: true,
      burstWindowMs: 50,
    });
    editor.setText("submitted message");

    editor.handleInput("\r");
    for (const character of "new draft") {
      editor.handleInput(character);
    }

    vi.advanceTimersByTime(50);

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith("submitted message");
    expect(editor.getText()).toBe("new draft");
    vi.useRealTimers();
  });

  it("preserves text typed after a buffered submit is blocked", () => {
    vi.useFakeTimers();
    const tui = { requestRender: vi.fn() } as unknown as TUI;
    const editor = new CustomEditor(tui, editorTheme);
    const sendMessage = vi.fn();
    const submit = createEditorSubmitHandler({
      editor,
      handleCommand: vi.fn(),
      sendMessage,
      handleBangLine: vi.fn(),
      onSubmitError: vi.fn(),
      admitMessage: () => ({ status: "blocked", reason: "pending" }),
    });
    editor.onSubmit = createSubmitBurstCoalescer({
      submit,
      enabled: true,
      burstWindowMs: 50,
    });
    editor.setText("blocked message");

    editor.handleInput("\r");
    for (const character of "plus newer text") {
      editor.handleInput(character);
    }
    vi.advanceTimersByTime(50);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("blocked message\nplus newer text");
    vi.useRealTimers();
  });

  it("passes through immediately when disabled", () => {
    const submit = vi.fn();
    const submitBurst = createSubmitBurstCoalescer({
      submit,
      enabled: false,
    });

    submitBurst("Line 1");
    submitBurst("Line 2");

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenNthCalledWith(1, "Line 1");
    expect(submit).toHaveBeenNthCalledWith(2, "Line 2");
  });

  it("cancels pending and future submissions when disposed", () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    const submitBurst = createSubmitBurstCoalescer({
      submit,
      enabled: true,
      burstWindowMs: 50,
    });

    submitBurst("pending");
    submitBurst.dispose();
    submitBurst.dispose();
    submitBurst("after dispose");
    vi.advanceTimersByTime(50);

    expect(submit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("shouldEnableWindowsGitBashPasteFallback", () => {
  it("enables fallback on Windows Git Bash env", () => {
    expect(
      shouldEnableWindowsGitBashPasteFallback({
        platform: "win32",
        env: {
          MSYSTEM: "MINGW64",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(true);
  });

  it("enables fallback on macOS iTerm", () => {
    expect(
      shouldEnableWindowsGitBashPasteFallback({
        platform: "darwin",
        env: {
          TERM_PROGRAM: "iTerm.app",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(true);
  });

  it("enables fallback on macOS Terminal.app", () => {
    expect(
      shouldEnableWindowsGitBashPasteFallback({
        platform: "darwin",
        env: {
          TERM_PROGRAM: "Apple_Terminal",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(true);
  });

  it("disables fallback outside Windows", () => {
    expect(
      shouldEnableWindowsGitBashPasteFallback({
        platform: "linux",
        env: {
          MSYSTEM: "MINGW64",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });
});
