// Clack prompter tests cover prompt rendering, validation, and cancellation.
import type { SpinnerOptions } from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";

const themeMocks = vi.hoisted(() => ({
  isRich: vi.fn(() => false),
}));

const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const stdoutColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");

function stubStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function stubStdoutColumns(value: number | undefined): void {
  Object.defineProperty(process.stdout, "columns", { configurable: true, value });
}

const cliProgressMocks = vi.hoisted(() => ({
  createCliProgress: vi.fn(() => ({
    done: vi.fn(),
    setLabel: vi.fn(),
  })),
}));

const terminalNoteMocks = vi.hoisted(() => ({
  note: vi.fn(),
}));

const clackMocks = vi.hoisted(() => ({
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
  cancel: vi.fn(),
  confirm: vi.fn(),
  intro: vi.fn(),
  isCancel: vi.fn(() => false),
  multiselect: vi.fn(),
  outro: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
  settings: { actions: new Set(["left", "right"]) },
  spinner: vi.fn((_options?: SpinnerOptions) => ({
    start: vi.fn(),
    message: vi.fn(),
    clear: vi.fn(),
    stop: vi.fn(),
  })),
  text: vi.fn(),
}));

const navigationPromptMocks = vi.hoisted(() => ({
  autocompleteMultiselectWithNavigationFooter: vi.fn(),
  autocompleteWithNavigationFooter: vi.fn(),
  confirmWithNavigationFooter: vi.fn(),
  multiselectWithNavigationFooter: vi.fn(),
  passwordWithNavigationFooter: vi.fn(),
  selectWithNavigationFooter: vi.fn(),
  textWithNavigationFooter: vi.fn(),
}));

vi.mock("../../packages/terminal-core/src/theme.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/terminal-core/src/theme.js")>();
  return {
    ...actual,
    isRich: themeMocks.isRich,
  };
});

vi.mock("@clack/prompts", () => ({
  autocomplete: clackMocks.autocomplete,
  autocompleteMultiselect: clackMocks.autocompleteMultiselect,
  cancel: clackMocks.cancel,
  confirm: clackMocks.confirm,
  intro: clackMocks.intro,
  isCancel: clackMocks.isCancel,
  multiselect: clackMocks.multiselect,
  outro: clackMocks.outro,
  password: clackMocks.password,
  select: clackMocks.select,
  settings: clackMocks.settings,
  spinner: clackMocks.spinner,
  text: clackMocks.text,
}));

vi.mock("../cli/progress.js", () => ({
  createCliProgress: cliProgressMocks.createCliProgress,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note: terminalNoteMocks.note,
}));

vi.mock("./clack-navigation-prompts.js", () => ({
  autocompleteMultiselectWithNavigationFooter:
    navigationPromptMocks.autocompleteMultiselectWithNavigationFooter,
  autocompleteWithNavigationFooter: navigationPromptMocks.autocompleteWithNavigationFooter,
  confirmWithNavigationFooter: navigationPromptMocks.confirmWithNavigationFooter,
  multiselectWithNavigationFooter: navigationPromptMocks.multiselectWithNavigationFooter,
  passwordWithNavigationFooter: navigationPromptMocks.passwordWithNavigationFooter,
  selectWithNavigationFooter: navigationPromptMocks.selectWithNavigationFooter,
  textWithNavigationFooter: navigationPromptMocks.textWithNavigationFooter,
}));

import { theme } from "../../packages/terminal-core/src/theme.js";
import { createClackPrompter, tokenizedOptionFilter } from "./clack-prompter.js";
import { WizardCancelledError, WizardNavigationError } from "./prompts.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  if (stdoutIsTTYDescriptor) {
    Object.defineProperty(process.stdout, "isTTY", stdoutIsTTYDescriptor);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
  if (stdoutColumnsDescriptor) {
    Object.defineProperty(process.stdout, "columns", stdoutColumnsDescriptor);
  } else {
    Reflect.deleteProperty(process.stdout, "columns");
  }
  themeMocks.isRich.mockReturnValue(false);
  clackMocks.settings.actions = new Set(["left", "right"]);
});

describe("tokenizedOptionFilter", () => {
  it("matches tokens regardless of order", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "openai/gpt-5.4",
      hint: "ctx 400k",
    };

    expect(tokenizedOptionFilter("gpt-5.4 openai/", option)).toBe(true);
    expect(tokenizedOptionFilter("openai/ gpt-5.4", option)).toBe(true);
  });

  it("requires all tokens to match", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "openai/gpt-5.4",
    };

    expect(tokenizedOptionFilter("gpt-5.4 anthropic/", option)).toBe(false);
  });

  it("matches against label, hint, and value", () => {
    const option = {
      value: "openai/gpt-5.4",
      label: "GPT 5.4",
      hint: "provider openai",
    };

    expect(tokenizedOptionFilter("provider openai", option)).toBe(true);
    expect(tokenizedOptionFilter("openai gpt-5.4", option)).toBe(true);
  });
});

describe("createClackPrompter", () => {
  it("clamps long progress labels by display width without splitting grapheme clusters", () => {
    stubStdoutColumns(20);
    const prompter = createClackPrompter();

    const progress = prompter.progress("12345678😀ABC");
    progress.update("正在扫描已安装应用…");
    progress.stop("1234567890ABC");

    const spin = clackMocks.spinner.mock.results[0]!.value;
    const osc = cliProgressMocks.createCliProgress.mock.results[0]!.value;
    expect(spin.start).toHaveBeenCalledWith(theme.accent("12345678…"));
    expect(spin.message).toHaveBeenCalledWith(theme.accent("正在扫描…"));
    expect(spin.stop).toHaveBeenCalledWith("1234567890ABC");
    expect(cliProgressMocks.createCliProgress).toHaveBeenCalledWith(
      expect.objectContaining({ label: "12345678😀ABC" }),
    );
    expect(osc.setLabel).toHaveBeenCalledWith("正在扫描已安装应用…");
  });

  it("preserves emoji joined by zero-width joiners when truncating", () => {
    stubStdoutColumns(14);
    const prompter = createClackPrompter();

    prompter.progress("👨‍👩‍👧‍👦ABCDEFGH");

    const spin = clackMocks.spinner.mock.results[0]!.value;
    expect(spin.start).toHaveBeenCalledWith(theme.accent("👨‍👩‍👧‍👦A…"));
  });

  it("shrinks active progress labels without expanding past the initial width", () => {
    stubStdoutColumns(20);
    const initialResizeListeners = process.stdout.listenerCount("resize");
    const prompter = createClackPrompter();

    const progress = prompter.progress("123456789ABC");
    stubStdoutColumns(14);
    process.stdout.emit("resize");
    stubStdoutColumns(30);
    process.stdout.emit("resize");
    progress.update("ABCDEFGHIJK");
    progress.stop();

    const spin = clackMocks.spinner.mock.results[0]!.value;
    expect(spin.message).toHaveBeenNthCalledWith(1, theme.accent("123…"));
    expect(spin.message).toHaveBeenNthCalledWith(2, theme.accent("ABC…"));
    expect(process.stdout.listenerCount("resize")).toBe(initialResizeListeners);
  });

  it("leaves progress labels untouched when terminal columns are unavailable", () => {
    stubStdoutColumns(undefined);
    const prompter = createClackPrompter();

    prompter.progress("1234567890ABC");

    const spin = clackMocks.spinner.mock.results[0]!.value;
    expect(spin.start).toHaveBeenCalledWith(theme.accent("1234567890ABC"));
  });

  it("leaves short progress labels untouched", () => {
    stubStdoutColumns(20);
    const prompter = createClackPrompter();

    prompter.progress("Loading");

    const spin = clackMocks.spinner.mock.results[0]!.value;
    expect(spin.start).toHaveBeenCalledWith(theme.accent("Loading"));
  });

  it("uses an empty progress label when decoration consumes the terminal width", () => {
    stubStdoutColumns(10);
    const prompter = createClackPrompter();

    prompter.progress("Loading");

    const spin = clackMocks.spinner.mock.results[0]!.value;
    expect(spin.start).toHaveBeenCalledWith(theme.accent(""));
  });

  it("uses the claw spinner on rich interactive terminals", () => {
    stubStdoutIsTTY(true);
    vi.stubEnv("CI", "");
    vi.stubEnv("VITEST", "");
    themeMocks.isRich.mockReturnValue(true);
    const prompter = createClackPrompter();

    prompter.progress("Loading");

    expect(clackMocks.spinner).toHaveBeenCalledWith({
      frames: ["(\\/)", "(||)", "(--)", "(||)"],
      delay: 120,
      styleFrame: theme.accent,
      output: process.stdout,
    });
  });

  it("keeps Clack's default spinner on non-rich terminals", () => {
    stubStdoutIsTTY(true);
    vi.stubEnv("CI", "");
    vi.stubEnv("VITEST", "");
    themeMocks.isRich.mockReturnValue(false);
    const prompter = createClackPrompter();

    prompter.progress("Loading");

    expect(clackMocks.spinner).toHaveBeenCalledWith({ output: process.stdout });
  });

  it("routes Clack UI, prompts, notes, plain text, and progress to the selected output", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    clackMocks.confirm.mockResolvedValue(true);
    const prompter = createClackPrompter(process.stderr);

    await prompter.intro("Add agent");
    await prompter.note("Details", "Agent");
    await prompter.plain?.("plain");
    await prompter.confirm({ message: "Continue?" });
    await prompter.outro("Ready");
    const progress = prompter.progress("Loading");
    progress.update("Still loading");
    progress.stop();

    expect(clackMocks.intro).toHaveBeenCalledWith(expect.any(String), {
      output: process.stderr,
    });
    expect(terminalNoteMocks.note).toHaveBeenCalledWith("Details", "Agent", process.stderr);
    expect(stderrWrite).toHaveBeenCalledWith("plain\n");
    expect(clackMocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ output: process.stderr }),
    );
    expect(clackMocks.outro).toHaveBeenCalledWith(expect.any(String), {
      output: process.stderr,
    });
    expect(clackMocks.spinner).toHaveBeenCalledWith({ output: process.stderr });
    expect(cliProgressMocks.createCliProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stream: process.stderr }),
    );
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("prints plain output without note framing", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prompter = createClackPrompter();

    await prompter.plain?.('{"ok":true}');

    expect(write).toHaveBeenCalledWith('{"ok":true}\n');
  });

  it("renders vertical confirms with Clack's native layout", async () => {
    clackMocks.confirm.mockResolvedValue(true);
    const prompter = createClackPrompter();

    await expect(
      prompter.confirm({
        message: "Continue?",
        layout: "vertical",
      }),
    ).resolves.toBe(true);

    expect(clackMocks.select).not.toHaveBeenCalled();
    expect(clackMocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: undefined,
        vertical: true,
      }),
    );
  });

  it("uses navigation-aware searchable selects when prompt navigation is active", async () => {
    navigationPromptMocks.autocompleteWithNavigationFooter.mockResolvedValue("two");
    const prompter = createClackPrompter();

    await expect(
      prompter.select({
        message: "Pick",
        options: [
          { value: "one", label: "One" },
          { value: "two", label: "Two" },
        ],
        searchable: true,
        navigation: { canGoBack: true, canGoForward: false },
      }),
    ).resolves.toBe("two");

    expect(clackMocks.autocomplete).not.toHaveBeenCalled();
    expect(navigationPromptMocks.autocompleteWithNavigationFooter).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Pick"),
        navigation: { canGoBack: true, canGoForward: false },
      }),
    );
  });

  it("passes abort signals to navigation-aware confirms", async () => {
    navigationPromptMocks.confirmWithNavigationFooter.mockResolvedValue(true);
    const prompter = createClackPrompter();

    await expect(
      prompter.confirm({
        message: "Continue?",
        layout: "vertical",
        navigation: { canGoBack: true, canGoForward: false },
      }),
    ).resolves.toBe(true);

    expect(clackMocks.confirm).not.toHaveBeenCalled();
    expect(clackMocks.select).not.toHaveBeenCalled();
    expect(navigationPromptMocks.confirmWithNavigationFooter).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Continue?"),
        initialValue: undefined,
        vertical: true,
        navigation: { canGoBack: true, canGoForward: false },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("passes abort signals to navigation-aware text prompts", async () => {
    navigationPromptMocks.textWithNavigationFooter.mockResolvedValue("workspace");
    const prompter = createClackPrompter();

    await expect(
      prompter.text({
        message: "Workspace",
        initialValue: "~/.openclaw/workspace",
        placeholder: "path",
        navigation: { canGoBack: true, canGoForward: true },
      }),
    ).resolves.toBe("workspace");

    expect(clackMocks.text).not.toHaveBeenCalled();
    expect(navigationPromptMocks.textWithNavigationFooter).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Workspace"),
        initialValue: "~/.openclaw/workspace",
        placeholder: "path",
        navigation: { canGoBack: true, canGoForward: true },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("cancels text prompts silently when their owner aborts them", async () => {
    const controller = new AbortController();
    clackMocks.isCancel.mockReturnValueOnce(true);
    clackMocks.text.mockImplementation(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise<symbol>((resolve) => {
          signal?.addEventListener("abort", () => resolve(Symbol("clack:cancel")), { once: true });
        }),
    );
    const prompter = createClackPrompter();

    const prompt = prompter.text({ message: "Paste callback", signal: controller.signal });
    controller.abort();

    await expect(prompt).rejects.toBeInstanceOf(WizardCancelledError);
    expect(clackMocks.cancel).not.toHaveBeenCalled();
    const signal = clackMocks.text.mock.calls[0]?.[0].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(true);
  });

  it.each([
    {
      label: "ordinary",
      run: () => createClackPrompter().confirm({ message: "Continue?" }),
      mock: clackMocks.confirm,
    },
    {
      label: "navigation-aware",
      run: () =>
        createClackPrompter().select({
          message: "Pick",
          options: [{ value: "one", label: "One" }],
          navigation: { canGoBack: true, canGoForward: false },
        }),
      mock: navigationPromptMocks.selectWithNavigationFooter,
    },
  ])("turns stdin EOF into wizard cancellation for $label prompts", async ({ run, mock }) => {
    const initialEndListeners = process.stdin.listenerCount("end");
    const initialKeypressListeners = process.stdin.listenerCount("keypress");
    mock.mockImplementation(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise<symbol>((resolve) => {
          signal?.addEventListener("abort", () => resolve(Symbol("clack:cancel")), { once: true });
        }),
    );
    clackMocks.isCancel.mockReturnValueOnce(true);

    const prompt = run();
    await Promise.resolve();
    process.stdin.emit("end");

    await expect(prompt).rejects.toBeInstanceOf(WizardCancelledError);
    expect(process.stdin.listenerCount("end")).toBe(initialEndListeners);
    expect(process.stdin.listenerCount("keypress")).toBe(initialKeypressListeners);
  });

  it("lets Clack own Ctrl-D finalization before the wrapper aborts", async () => {
    const initialEndListeners = process.stdin.listenerCount("end");
    const initialKeypressListeners = process.stdin.listenerCount("keypress");
    const finalize = vi.fn();
    const restoreRawMode = vi.fn();
    const writeNewline = vi.fn();

    clackMocks.confirm.mockImplementation(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise<symbol>((resolve) => {
          const finish = () => {
            finalize();
            restoreRawMode(false);
            writeNewline("\n");
            process.stdin.off("keypress", onClackKeypress);
            resolve(Symbol("clack:cancel"));
          };
          const onClackKeypress = (input: string | undefined) => {
            if (input === "\x04") {
              finish();
            }
          };
          process.stdin.on("keypress", onClackKeypress);
          signal?.addEventListener("abort", finish, { once: true });
        }),
    );
    clackMocks.isCancel.mockReturnValueOnce(true);

    const prompt = createClackPrompter().confirm({ message: "Continue?" });
    await Promise.resolve();
    process.stdin.emit("keypress", "\x04", { ctrl: true, name: "d" });

    await expect(prompt).rejects.toBeInstanceOf(WizardCancelledError);
    expect(finalize).toHaveBeenCalledOnce();
    expect(restoreRawMode).toHaveBeenCalledOnce();
    expect(writeNewline).toHaveBeenCalledOnce();
    expect(process.stdin.listenerCount("end")).toBe(initialEndListeners);
    expect(process.stdin.listenerCount("keypress")).toBe(initialKeypressListeners);
  });

  it("lets Clack settle final piped input before the stdin end fallback", async () => {
    const initialEndListeners = process.stdin.listenerCount("end");
    const initialKeypressListeners = process.stdin.listenerCount("keypress");
    const finalize = vi.fn();
    const restoreRawMode = vi.fn();
    const writeNewline = vi.fn();
    const cleanup = vi.fn();

    clackMocks.confirm.mockImplementation(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise<boolean>((resolve) => {
          const finish = () => {
            finalize();
            restoreRawMode(false);
            writeNewline("\n");
            cleanup();
          };
          const onEnd = () => {
            finish();
            resolve(true);
          };
          process.stdin.once("end", onEnd);
          signal?.addEventListener("abort", finish, { once: true });
        }),
    );

    const prompt = createClackPrompter().confirm({ message: "Continue?" });
    await Promise.resolve();
    process.stdin.emit("data", "y\n");
    process.stdin.emit("end");

    await expect(prompt).resolves.toBe(true);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(finalize).toHaveBeenCalledOnce();
    expect(restoreRawMode).toHaveBeenCalledOnce();
    expect(writeNewline).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(process.stdin.listenerCount("end")).toBe(initialEndListeners);
    expect(process.stdin.listenerCount("keypress")).toBe(initialKeypressListeners);
  });

  it("keeps Ctrl-C cancellation on Clack's canonical path", async () => {
    clackMocks.confirm.mockResolvedValue(Symbol("clack:cancel"));
    clackMocks.isCancel.mockReturnValueOnce(true);

    await expect(createClackPrompter().confirm({ message: "Continue?" })).rejects.toBeInstanceOf(
      WizardCancelledError,
    );

    expect(clackMocks.cancel).toHaveBeenCalledWith(expect.any(String), {
      output: process.stdout,
    });
  });

  it("rejects navigation after Clack resolves an aborted prompt", async () => {
    navigationPromptMocks.textWithNavigationFooter.mockImplementation(async ({ signal }) => {
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      return Symbol("clack:cancel");
    });
    const prompter = createClackPrompter();

    const result = prompter.text({
      message: "Workspace",
      navigation: { canGoBack: false, canGoForward: true },
    });
    await Promise.resolve();
    process.stdin.emit("keypress", undefined, { name: "right" });

    await expect(result).rejects.toMatchObject({
      direction: "forward",
    } satisfies Partial<WizardNavigationError>);
  });

  it("keeps text cursor actions when prompt navigation has no available move", async () => {
    navigationPromptMocks.textWithNavigationFooter.mockImplementation(async () => {
      expect(clackMocks.settings.actions.has("left")).toBe(true);
      expect(clackMocks.settings.actions.has("right")).toBe(true);
      return "workspace";
    });
    const prompter = createClackPrompter();

    await expect(
      prompter.text({
        message: "Workspace",
        navigation: { canGoBack: false, canGoForward: false },
      }),
    ).resolves.toBe("workspace");

    expect(navigationPromptMocks.textWithNavigationFooter).toHaveBeenCalledWith(
      expect.objectContaining({
        navigation: { canGoBack: false, canGoForward: false },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("passes abort signals to navigation-aware password prompts", async () => {
    navigationPromptMocks.passwordWithNavigationFooter.mockResolvedValue("secret");
    const prompter = createClackPrompter();

    await expect(
      prompter.text({
        message: "API key",
        sensitive: true,
        navigation: { canGoBack: true, canGoForward: true },
      }),
    ).resolves.toBe("secret");

    expect(clackMocks.password).not.toHaveBeenCalled();
    expect(navigationPromptMocks.passwordWithNavigationFooter).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("API key"),
        navigation: { canGoBack: true, canGoForward: true },
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
