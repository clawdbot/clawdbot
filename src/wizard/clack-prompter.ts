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
  select,
  spinner,
  text,
} from "@clack/prompts";
import { createCliProgress } from "../cli/progress.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { stripAnsi } from "../terminal/ansi.js";
import { note as emitNote } from "../terminal/note.js";
import { stylePromptHint, stylePromptMessage, stylePromptTitle } from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";
import type { WizardProgress, WizardPrompter } from "./prompts.js";
import { WizardCancelledError } from "./prompts.js";

function guardCancel<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel(stylePromptTitle("Setup cancelled.") ?? "Setup cancelled.");
    throw new WizardCancelledError();
  }
  return value;
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
      const options = params.options.map((opt) => {
        const base = { value: opt.value, label: opt.label };
        return opt.hint === undefined ? base : { ...base, hint: stylePromptHint(opt.hint) };
      }) as Option<(typeof params.options)[number]["value"]>[];

      if (params.searchable) {
        return guardCancel(
          await autocomplete({
            message: stylePromptMessage(params.message),
            options,
            initialValue: params.initialValue,
            filter: tokenizedOptionFilter,
          }),
        );
      }

      return guardCancel(
        await select({
          message: stylePromptMessage(params.message),
          options,
          initialValue: params.initialValue,
        }),
      );
    },
    multiselect: async (params) => {
      const options = params.options.map((opt) => {
        const base = { value: opt.value, label: opt.label };
        return opt.hint === undefined ? base : { ...base, hint: stylePromptHint(opt.hint) };
      }) as Option<(typeof params.options)[number]["value"]>[];

      if (params.searchable) {
        return guardCancel(
          await autocompleteMultiselect({
            message: stylePromptMessage(params.message),
            options,
            initialValues: params.initialValues,
            filter: tokenizedOptionFilter,
          }),
        );
      }

      return guardCancel(
        await multiselect({
          message: stylePromptMessage(params.message),
          options,
          initialValues: params.initialValues,
        }),
      );
    },
    text: async (params) => {
      const validate = params.validate;
      return guardCancel(
        await text({
          message: stylePromptMessage(params.message),
          initialValue: params.initialValue,
          placeholder: params.placeholder,
          validate: validate ? (value) => validate(value ?? "") : undefined,
        }),
      );
    },
    confirm: async (params) =>
      guardCancel(
        await confirm({
          message: stylePromptMessage(params.message),
          initialValue: params.initialValue,
        }),
      ),
    progress: (label: string): WizardProgress => {
      const spin = spinner();
      spin.start(theme.accent(label));
      const osc = createCliProgress({
        label,
        indeterminate: true,
        enabled: true,
        fallback: "none",
      });
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
