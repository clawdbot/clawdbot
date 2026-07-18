// Clack prompter adapts wizard prompt requests to Clack terminal prompts.
import {
  autocomplete,
  autocompleteMultiselect,
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  type Option,
  outro,
  password,
  select,
  settings,
  spinner,
  text,
} from "@clack/prompts";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import { note as emitNote } from "../../packages/terminal-core/src/note.js";
import { styleSelectParams } from "../../packages/terminal-core/src/prompt-select-styled-params.js";
import {
  stylePromptMessage,
  stylePromptTitle,
} from "../../packages/terminal-core/src/prompt-style.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { createCliProgress } from "../cli/progress.js";
import {
  autocompleteMultiselectWithNavigationFooter,
  autocompleteWithNavigationFooter,
  confirmWithNavigationFooter,
  multiselectWithNavigationFooter,
  passwordWithNavigationFooter,
  selectWithNavigationFooter,
  textWithNavigationFooter,
} from "./clack-navigation-prompts.js";
import type { WizardProgress, WizardPrompter, WizardPromptNavigation } from "./prompts.js";
import { WizardCancelledError, WizardNavigationError } from "./prompts.js";

// Same species as the pixel-mascot banner, compressed into a four-column
// spinner for long-running wizard steps.
const CLAW_SPINNER_FRAMES = ["(\\/)", "(||)", "(--)", "(||)"];

// Clack-backed WizardPrompter implementation for interactive CLI setup. It
// converts the generic wizard prompt contract into styled Clack prompts.
function guardCancel<T>(value: T | symbol, signal?: AbortSignal): T {
  if (isCancel(value)) {
    if (!signal?.aborted) {
      cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
    }
    throw new WizardCancelledError();
  }
  return value;
}

type KeypressInfo = {
  name?: string;
};

function resolveNavigationDirection(
  navigation: WizardPromptNavigation | undefined,
  key: KeypressInfo | undefined,
): "back" | "forward" | undefined {
  if (key?.name === "left" && navigation?.canGoBack) {
    return "back";
  }
  if (key?.name === "right" && navigation?.canGoForward) {
    return "forward";
  }
  return undefined;
}

function hasPromptNavigation(navigation: WizardPromptNavigation | undefined): boolean {
  return navigation?.canGoBack === true || navigation?.canGoForward === true;
}

async function withHorizontalCursorActionsDisabled<T>(
  disabled: boolean,
  work: () => Promise<T>,
): Promise<T> {
  if (!disabled) {
    return await work();
  }

  const hadLeft = settings.actions.has("left");
  const hadRight = settings.actions.has("right");
  settings.actions.delete("left");
  settings.actions.delete("right");
  try {
    return await work();
  } finally {
    if (hadLeft) {
      settings.actions.add("left");
    }
    if (hadRight) {
      settings.actions.add("right");
    }
  }
}

async function runPromptWithNavigation<T>(
  navigation: WizardPromptNavigation | undefined,
  work: (signal: AbortSignal | undefined) => Promise<T | symbol>,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (!hasPromptNavigation(navigation)) {
    return guardCancel(await work(externalSignal), externalSignal);
  }

  const controller = new AbortController();
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  let navigationDirection: "back" | "forward" | undefined;
  const onKeypress = (_input: string | undefined, key: KeypressInfo | undefined) => {
    const nextDirection = resolveNavigationDirection(navigation, key);
    if (!nextDirection) {
      return;
    }
    navigationDirection ??= nextDirection;
    controller.abort();
  };

  try {
    process.stdin.on("keypress", onKeypress);
    const value = await work(signal);
    if (navigationDirection) {
      throw new WizardNavigationError(navigationDirection);
    }
    return guardCancel(value, externalSignal);
  } finally {
    process.stdin.off("keypress", onKeypress);
  }
}

function normalizeSearchTokens(search: string): string[] {
  return normalizeLowercaseStringOrEmpty(search)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function buildOptionSearchText<T>(option: Option<T>): string {
  const label = stripAnsi(option.label ?? "");
  const hint = stripAnsi(option.hint ?? "");
  const value = String(option.value ?? "");
  return normalizeLowercaseStringOrEmpty(`${label} ${hint} ${value}`);
}

export function tokenizedOptionFilter<T>(search: string, option: Option<T>): boolean {
  const tokens = normalizeSearchTokens(search);
  if (tokens.length === 0) {
    return true;
  }
  const haystack = buildOptionSearchText(option);
  return tokens.every((token) => haystack.includes(token));
}

// Public factory used by setup/onboard commands. Keep side effects inside method
// calls so tests can import the module without starting prompts.
export function createClackPrompter(): WizardPrompter {
  return {
    intro: async (title) => {
      intro(stylePromptTitle(title) ?? title);
    },
    outro: async (message) => {
      outro(stylePromptTitle(message) ?? message);
    },
    note: async (message, title) => {
      emitNote(message, title);
    },
    plain: async (message) => {
      process.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
    },
    select: async (params) => {
      const { message, options: styledOptions } = styleSelectParams(params);
      const options = styledOptions as Option<(typeof params.options)[number]["value"]>[];

      return await withHorizontalCursorActionsDisabled(
        hasPromptNavigation(params.navigation),
        async () =>
          await runPromptWithNavigation(params.navigation, async (signal) => {
            if (params.searchable) {
              return params.navigation
                ? await autocompleteWithNavigationFooter({
                    message,
                    options,
                    initialValue: params.initialValue,
                    filter: tokenizedOptionFilter,
                    signal,
                    navigation: params.navigation,
                  })
                : await autocomplete({
                    message,
                    options,
                    initialValue: params.initialValue,
                    filter: tokenizedOptionFilter,
                    signal,
                  });
            }
            return params.navigation
              ? await selectWithNavigationFooter({
                  message,
                  options,
                  initialValue: params.initialValue,
                  signal,
                  navigation: params.navigation,
                })
              : await select({
                  message,
                  options,
                  initialValue: params.initialValue,
                  signal,
                });
          }),
      );
    },
    multiselect: async (params) => {
      const { message, options: styledOptions } = styleSelectParams(params);
      const options = styledOptions as Option<(typeof params.options)[number]["value"]>[];

      return await withHorizontalCursorActionsDisabled(
        hasPromptNavigation(params.navigation),
        async () =>
          await runPromptWithNavigation(params.navigation, async (signal) => {
            if (params.searchable) {
              return params.navigation
                ? await autocompleteMultiselectWithNavigationFooter({
                    message,
                    options,
                    initialValues: params.initialValues,
                    filter: tokenizedOptionFilter,
                    signal,
                    navigation: params.navigation,
                  })
                : await autocompleteMultiselect({
                    message,
                    options,
                    initialValues: params.initialValues,
                    filter: tokenizedOptionFilter,
                    signal,
                  });
            }
            return params.navigation
              ? await multiselectWithNavigationFooter({
                  message,
                  options,
                  initialValues: params.initialValues,
                  signal,
                  navigation: params.navigation,
                })
              : await multiselect({
                  message,
                  options,
                  initialValues: params.initialValues,
                  signal,
                });
          }),
      );
    },
    text: async (params) => {
      const validate = params.validate;
      return await withHorizontalCursorActionsDisabled(
        hasPromptNavigation(params.navigation),
        async () =>
          await runPromptWithNavigation(
            params.navigation,
            async (signal) => {
              const message = stylePromptMessage(params.message);
              const validateInput = validate
                ? (value: string | undefined) => validate(value ?? "")
                : undefined;
              if (params.sensitive) {
                return params.navigation
                  ? await passwordWithNavigationFooter({
                      message,
                      validate: validateInput,
                      navigation: params.navigation,
                      signal,
                    })
                  : await password({ message, validate: validateInput, signal });
              }
              return params.navigation
                ? await textWithNavigationFooter({
                    message,
                    initialValue: params.initialValue,
                    placeholder: params.placeholder,
                    validate: validateInput,
                    navigation: params.navigation,
                    signal,
                  })
                : await text({
                    message,
                    initialValue: params.initialValue,
                    placeholder: params.placeholder,
                    validate: validateInput,
                    signal,
                  });
            },
            params.signal,
          ),
      );
    },
    confirm: async (params) =>
      await withHorizontalCursorActionsDisabled(
        hasPromptNavigation(params.navigation),
        async () =>
          await runPromptWithNavigation(params.navigation, async (signal) => {
            const message = stylePromptMessage(params.message);
            if (params.navigation) {
              return await confirmWithNavigationFooter({
                message,
                initialValue: params.initialValue,
                vertical: params.layout === "vertical",
                navigation: params.navigation,
                signal,
              });
            }
            return await confirm({
              message,
              initialValue: params.initialValue,
              vertical: params.layout === "vertical",
              signal,
            });
          }),
      ),
    progress: (label: string): WizardProgress => {
      const useClawSpinner =
        process.stdout.isTTY && isRich() && !process.env.CI && !process.env.VITEST;
      const spin = useClawSpinner
        ? spinner({
            frames: CLAW_SPINNER_FRAMES,
            delay: 120,
            styleFrame: theme.accent,
          })
        : spinner();
      spin.start(theme.accent(label));
      const osc = createCliProgress({
        label,
        indeterminate: true,
        enabled: true,
        fallback: "none",
      });
      // Drive both Clack spinner UI and OSC progress output for terminals that
      // display command progress outside the prompt line.
      return {
        update: (message) => {
          spin.message(theme.accent(message));
          osc.setLabel(message);
        },
        stop: (message) => {
          osc.done();
          if (message === undefined) {
            spin.clear();
          } else {
            spin.stop(message);
          }
        },
      };
    },
  };
}
