import { styleText } from "node:util";
import { MultiSelectPrompt, settings, wrapTextWithPrefix } from "@clack/core";
import {
  limitOptions,
  S_BAR,
  S_BAR_END,
  S_CHECKBOX_ACTIVE,
  S_CHECKBOX_INACTIVE,
  S_CHECKBOX_SELECTED,
  symbol,
  symbolBar,
} from "@clack/prompts";
import {
  reconcileInteractiveMigrationShortcutValues,
  reconcileInteractiveMigrationSkillToggleValues,
} from "./selection.js";

type MigrationSkillSelectionOption = {
  value: string;
  label?: string;
  hint?: string;
  disabled?: boolean;
};

export type MigrationSkillSelectionPromptOptions = {
  message: string;
  options: MigrationSkillSelectionOption[];
  initialValues?: string[];
  maxItems?: number;
  required?: boolean;
  cursorAt?: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  signal?: AbortSignal;
  withGuide?: boolean;
  selectableValues: readonly string[];
};

function formatOption(
  option: MigrationSkillSelectionOption,
  state:
    | "active"
    | "active-selected"
    | "cancelled"
    | "disabled"
    | "inactive"
    | "selected"
    | "submitted",
): string {
  const label = option.label ?? option.value;
  const withHint = option.hint ? `${label} ${styleText("dim", `(${option.hint})`)}` : label;
  switch (state) {
    case "active":
      return `${styleText("cyan", S_CHECKBOX_ACTIVE)} ${withHint}`;
    case "active-selected":
      return `${styleText("green", S_CHECKBOX_SELECTED)} ${withHint}`;
    case "cancelled":
      return styleText(["strikethrough", "dim"], label);
    case "disabled":
      return `${styleText("gray", S_CHECKBOX_INACTIVE)} ${styleText(["strikethrough", "gray"], label)}${
        option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""
      }`;
    case "selected":
      return `${styleText("green", S_CHECKBOX_SELECTED)} ${styleText("dim", withHint)}`;
    case "submitted":
      return styleText("dim", label);
    case "inactive":
      return `${styleText("dim", S_CHECKBOX_INACTIVE)} ${styleText("dim", withHint)}`;
  }
  return withHint;
}

export function promptMigrationSkillSelectionValues(
  opts: MigrationSkillSelectionPromptOptions,
): Promise<string[] | symbol | undefined> {
  const required = opts.required ?? true;
  const prompt = new MultiSelectPrompt<MigrationSkillSelectionOption>({
    options: opts.options,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    initialValues: opts.initialValues,
    required,
    cursorAt: opts.cursorAt,
    validate(value) {
      if (required && (value === undefined || value.length === 0)) {
        return "Please select at least one option.";
      }
      return undefined;
    },
    render() {
      const withGuide = opts.withGuide ?? settings.withGuide;
      const message = wrapTextWithPrefix(
        opts.output,
        opts.message,
        withGuide ? `${symbolBar(this.state)}  ` : "",
        `${symbol(this.state)}  `,
      );
      const header = `${withGuide ? `${styleText("gray", S_BAR)}\n` : ""}${message}\n`;
      const value = this.value ?? [];
      const optionState = (option: MigrationSkillSelectionOption, active: boolean) => {
        if (option.disabled) {
          return formatOption(option, "disabled");
        }
        const selected = value.includes(option.value);
        if (active && selected) {
          return formatOption(option, "active-selected");
        }
        if (selected) {
          return formatOption(option, "selected");
        }
        return formatOption(option, active ? "active" : "inactive");
      };

      switch (this.state) {
        case "submit": {
          const selected = this.options
            .filter((option) => value.includes(option.value))
            .map((option) => formatOption(option, "submitted"))
            .join(styleText("dim", ", "));
          const label = selected || styleText("dim", "none");
          return `${header}${wrapTextWithPrefix(opts.output, label, withGuide ? `${styleText("gray", S_BAR)}  ` : "")}`;
        }
        case "cancel": {
          const selected = this.options
            .filter((option) => value.includes(option.value))
            .map((option) => formatOption(option, "cancelled"))
            .join(styleText("dim", ", "));
          if (selected.trim() === "") {
            return `${header}${styleText("gray", S_BAR)}`;
          }
          return `${header}${wrapTextWithPrefix(
            opts.output,
            selected,
            withGuide ? `${styleText("gray", S_BAR)}  ` : "",
          )}${withGuide ? `\n${styleText("gray", S_BAR)}` : ""}`;
        }
        case "error": {
          const prefix = withGuide ? `${styleText("yellow", S_BAR)}  ` : "";
          const body = limitOptions({
            output: opts.output,
            options: this.options,
            cursor: this.cursor,
            maxItems: opts.maxItems,
            columnPadding: prefix.length,
            rowPadding: header.split("\n").length + this.error.split("\n").length + 1,
            style: optionState,
          }).join(`\n${prefix}`);
          const error = this.error
            .split("\n")
            .map((line, index) =>
              index === 0
                ? `${withGuide ? `${styleText("yellow", S_BAR_END)}  ` : ""}${styleText("yellow", line)}`
                : `   ${line}`,
            )
            .join("\n");
          return `${header}${prefix}${body}\n${error}\n`;
        }
        default: {
          const prefix = withGuide ? `${styleText("cyan", S_BAR)}  ` : "";
          return `${header}${prefix}${limitOptions({
            output: opts.output,
            options: this.options,
            cursor: this.cursor,
            maxItems: opts.maxItems,
            columnPadding: prefix.length,
            rowPadding: header.split("\n").length + (withGuide ? 2 : 1),
            style: optionState,
          }).join(`\n${prefix}`)}\n${withGuide ? styleText("cyan", S_BAR_END) : ""}\n`;
        }
      }
    },
  });
  let lastSelectedValues = [...(prompt.value ?? [])];

  prompt.on("cursor", (key) => {
    if (key !== "space") {
      return;
    }
    const activatedValue = prompt.options[prompt.cursor]?.value;
    prompt.value = reconcileInteractiveMigrationSkillToggleValues(
      prompt.value ?? [],
      activatedValue,
      opts.selectableValues,
    );
    lastSelectedValues = [...(prompt.value ?? [])];
  });

  prompt.on("key", (key) => {
    if (key !== "a" && key !== "i") {
      return;
    }
    prompt.value = reconcileInteractiveMigrationShortcutValues(
      lastSelectedValues,
      prompt.value ?? [],
      opts.selectableValues,
      key,
    );
    lastSelectedValues = [...(prompt.value ?? [])];
  });

  return prompt.prompt();
}

export const promptMigrationSelectionValues = promptMigrationSkillSelectionValues;
