// Clack prompter tests cover prompt rendering, validation, and cancellation.
import type { SpinnerOptions } from "@clack/prompts";
import { afterEach, describe, expect, it, vi } from "vitest";

const themeMocks = vi.hoisted(() => ({
  isRich: vi.fn(() => false),
}));

const stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function stubStdoutIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

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
    });
  });

  it("keeps Clack's default spinner on non-rich terminals", () => {
    stubStdoutIsTTY(true);
    vi.stubEnv("CI", "");
    vi.stubEnv("VITEST", "");
    themeMocks.isRich.mockReturnValue(false);
    const prompter = createClackPrompter();

    prompter.progress("Loading");

    expect(clackMocks.spinner).toHaveBeenCalledWith();
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
    expect(clackMocks.text).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
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
        signal: undefined,
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
