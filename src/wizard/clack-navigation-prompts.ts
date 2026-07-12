// Clack prompt wrappers that add onboarding navigation footers.
import type { Writable } from "node:stream";
import { styleText } from "node:util";
import {
  AutocompletePrompt,
  ConfirmPrompt,
  MultiSelectPrompt,
  PasswordPrompt,
  SelectPrompt,
  settings as clackSettings,
  TextPrompt,
  wrapTextWithPrefix,
} from "@clack/core";
import {
  S_BAR,
  S_BAR_END,
  S_CHECKBOX_ACTIVE,
  S_CHECKBOX_INACTIVE,
  S_CHECKBOX_SELECTED,
  S_PASSWORD_MASK,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  limitOptions,
  symbol as clackSymbol,
  symbolBar as clackSymbolBar,
  type AutocompleteMultiSelectOptions,
  type AutocompleteOptions,
  type ConfirmOptions,
  type MultiSelectOptions,
  type PasswordOptions,
  type SelectOptions,
  type TextOptions,
} from "@clack/prompts";
import { expectDefined } from "@openclaw/normalization-core";
import type { WizardPromptNavigation } from "./prompts.js";

type PromptOption<Value> = {
  value: Value;
  label?: string;
  hint?: string;
  disabled?: boolean;
};

type NavigationPromptOptions = {
  navigation?: WizardPromptNavigation;
  withGuide?: boolean;
  output?: Writable;
};

function getOptionLabel<Value>(option: PromptOption<Value>): string {
  return option.label ?? String(option.value ?? "");
}

function computeLabel(label: string, format: (text: string) => string): string {
  if (!label.includes("\n")) {
    return format(label);
  }
  return label
    .split("\n")
    .map((line) => format(line))
    .join("\n");
}

function getFilteredOption<Value>(searchText: string, option: PromptOption<Value>): boolean {
  if (!searchText) {
    return true;
  }
  const term = searchText.toLowerCase();
  return (
    getOptionLabel(option).toLowerCase().includes(term) ||
    (option.hint ?? "").toLowerCase().includes(term) ||
    String(option.value).toLowerCase().includes(term)
  );
}

function getSelectedOptions<Value>(
  values: Value[],
  options: Array<PromptOption<Value>>,
): Array<PromptOption<Value>> {
  return options.filter((option) => values.includes(option.value));
}

function adaptOptionFilter<Value>(
  filter: AutocompleteOptions<Value>["filter"] | undefined,
): ((search: string, option: PromptOption<Value>) => boolean) | undefined {
  return filter ? (search, option) => filter(search, option as never) : undefined;
}

export function formatNavigationFooter(navigation: WizardPromptNavigation | undefined): string {
  if (!navigation || (!navigation.canGoBack && !navigation.canGoForward)) {
    return "";
  }
  return [
    navigation.canGoBack ? styleText("dim", "← back") : undefined,
    navigation.canGoForward ? styleText("dim", "→ next") : undefined,
  ]
    .filter(Boolean)
    .join("  ");
}

function navigationFooterLines(
  guideVisible: boolean,
  barStyle: "cyan" | "yellow",
  navigation: WizardPromptNavigation | undefined,
  extraHints: string[] = [],
): string[] {
  const footer = formatNavigationFooter(navigation);
  if (!footer) {
    return [];
  }
  const hintLine = [footer, ...extraHints].join("  ");
  const prefix = guideVisible ? `${styleText(barStyle, S_BAR)}  ` : "";
  return [`${prefix}${hintLine}`];
}

function hasGuide(opts: { withGuide?: boolean }): boolean {
  return opts.withGuide ?? clackSettings.withGuide;
}

function selectOptionRenderer<Value>(option: PromptOption<Value>, state: string): string {
  const label = getOptionLabel(option);
  switch (state) {
    case "disabled":
      return `${styleText("gray", S_RADIO_INACTIVE)} ${computeLabel(label, (text) => styleText("gray", text))}${
        option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""
      }`;
    case "selected":
      return computeLabel(label, (text) => styleText("dim", text));
    case "active":
      return `${styleText("green", S_RADIO_ACTIVE)} ${label}${
        option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""
      }`;
    case "cancelled":
      return computeLabel(label, (text) => styleText(["strikethrough", "dim"], text));
    default:
      return `${styleText("dim", S_RADIO_INACTIVE)} ${computeLabel(label, (text) =>
        styleText("dim", text),
      )}`;
  }
}

export function selectWithNavigationFooter<Value>(
  opts: SelectOptions<Value> & NavigationPromptOptions,
): Promise<Value | symbol> {
  return new SelectPrompt({
    options: opts.options as Array<PromptOption<Value>>,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    initialValue: opts.initialValue,
    render() {
      const showGuide = hasGuide(opts);
      const titlePrefix = `${clackSymbol(this.state)}  `;
      const titlePrefixBar = `${clackSymbolBar(this.state)}  `;
      const messageLines = wrapTextWithPrefix(
        opts.output,
        opts.message,
        titlePrefixBar,
        titlePrefix,
      );
      const title = `${showGuide ? `${styleText("gray", S_BAR)}\n` : ""}${messageLines}\n`;

      switch (this.state) {
        case "submit": {
          const submitPrefix = showGuide ? `${styleText("gray", S_BAR)}  ` : "";
          const wrappedLines = wrapTextWithPrefix(
            opts.output,
            selectOptionRenderer(
              expectDefined(this.options[this.cursor], "options entry at this.cursor"),
              "selected",
            ),
            submitPrefix,
          );
          return `${title}${wrappedLines}`;
        }
        case "cancel": {
          const cancelPrefix = showGuide ? `${styleText("gray", S_BAR)}  ` : "";
          const wrappedLines = wrapTextWithPrefix(
            opts.output,
            selectOptionRenderer(
              expectDefined(this.options[this.cursor], "options entry at this.cursor"),
              "cancelled",
            ),
            cancelPrefix,
          );
          return `${title}${wrappedLines}${showGuide ? `\n${styleText("gray", S_BAR)}` : ""}`;
        }
        default: {
          const prefix = showGuide ? `${styleText("cyan", S_BAR)}  ` : "";
          const footerLines = [
            ...navigationFooterLines(showGuide, "cyan", opts.navigation, [
              styleText("dim", "↑/↓ option"),
            ]),
            showGuide ? styleText("cyan", S_BAR_END) : "",
          ];
          const titleLineCount = title.split("\n").length;
          const footerLineCount = footerLines.length + 1;
          return `${title}${prefix}${limitOptions({
            output: opts.output,
            cursor: this.cursor,
            options: this.options,
            maxItems: opts.maxItems,
            columnPadding: prefix.length,
            rowPadding: titleLineCount + footerLineCount,
            style: (item, active) =>
              selectOptionRenderer(
                item,
                item.disabled ? "disabled" : active ? "active" : "inactive",
              ),
          }).join(`\n${prefix}`)}\n${footerLines.join("\n")}\n`;
        }
      }
    },
  }).prompt() as Promise<Value | symbol>;
}

export function autocompleteWithNavigationFooter<Value>(
  opts: AutocompleteOptions<Value> & NavigationPromptOptions,
): Promise<Value | symbol> {
  const prompt = new AutocompletePrompt<PromptOption<Value>>({
    options: opts.options as Array<PromptOption<Value>>,
    initialValue: opts.initialValue === undefined ? undefined : [opts.initialValue],
    initialUserInput: opts.initialUserInput,
    placeholder: opts.placeholder,
    filter: adaptOptionFilter(opts.filter) ?? getFilteredOption,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    validate: opts.validate,
    render() {
      const showGuide = hasGuide(opts);
      const headings = showGuide
        ? [styleText("gray", S_BAR), `${clackSymbol(this.state)}  ${opts.message}`]
        : [`${clackSymbol(this.state)}  ${opts.message}`];
      const userInput = this.userInput;
      const options = this.options;
      const showPlaceholder = userInput === "" && opts.placeholder !== undefined;
      const opt = (
        option: PromptOption<Value>,
        state: "inactive" | "active" | "disabled",
      ): string => {
        const label = getOptionLabel(option);
        const hint =
          option.hint && option.value === this.focusedValue
            ? styleText("dim", ` (${option.hint})`)
            : "";
        switch (state) {
          case "active":
            return `${styleText("green", S_RADIO_ACTIVE)} ${label}${hint}`;
          case "inactive":
            return `${styleText("dim", S_RADIO_INACTIVE)} ${styleText("dim", label)}`;
          case "disabled":
            return `${styleText("gray", S_RADIO_INACTIVE)} ${styleText(
              ["strikethrough", "gray"],
              label,
            )}`;
        }
        return "";
      };

      switch (this.state) {
        case "submit": {
          const selected = getSelectedOptions(this.selectedValues, options);
          const label =
            selected.length > 0
              ? `  ${styleText("dim", selected.map(getOptionLabel).join(", "))}`
              : "";
          const submitPrefix = showGuide ? styleText("gray", S_BAR) : "";
          return `${headings.join("\n")}\n${submitPrefix}${label}`;
        }
        case "cancel": {
          const userInputText = userInput
            ? `  ${styleText(["strikethrough", "dim"], userInput)}`
            : "";
          const cancelPrefix = showGuide ? styleText("gray", S_BAR) : "";
          return `${headings.join("\n")}\n${cancelPrefix}${userInputText}`;
        }
        default: {
          const barStyle = this.state === "error" ? "yellow" : "cyan";
          const guidePrefix = showGuide ? `${styleText(barStyle, S_BAR)}  ` : "";
          const guidePrefixEnd = showGuide ? styleText(barStyle, S_BAR_END) : "";
          const searchText =
            this.isNavigating || showPlaceholder
              ? opts.placeholder || userInput
                ? ` ${styleText("dim", showPlaceholder ? (opts.placeholder ?? "") : userInput)}`
                : ""
              : ` ${this.userInputWithCursor}`;
          const matches =
            this.filteredOptions.length !== options.length
              ? styleText(
                  "dim",
                  ` (${this.filteredOptions.length} match${
                    this.filteredOptions.length === 1 ? "" : "es"
                  })`,
                )
              : "";
          const noResults =
            this.filteredOptions.length === 0 && userInput
              ? [`${guidePrefix}${styleText("yellow", "No matches found")}`]
              : [];
          const validationError =
            this.state === "error" ? [`${guidePrefix}${styleText("yellow", this.error)}`] : [];
          if (showGuide) {
            headings.push(guidePrefix.trimEnd());
          }
          headings.push(
            `${guidePrefix}${styleText("dim", "Search:")}${searchText}${matches}`,
            ...noResults,
            ...validationError,
          );
          const instructions = [
            `${styleText("dim", "↑/↓")} to select`,
            `${styleText("dim", "Enter:")} confirm`,
            `${styleText("dim", "Type:")} to search`,
          ];
          const footers = [
            `${guidePrefix}${instructions.join(" • ")}`,
            ...navigationFooterLines(showGuide, barStyle, opts.navigation),
            guidePrefixEnd,
          ];
          const displayOptions =
            this.filteredOptions.length === 0
              ? []
              : limitOptions({
                  cursor: this.cursor,
                  options: this.filteredOptions,
                  columnPadding: showGuide ? 3 : 0,
                  rowPadding: headings.length + footers.length,
                  style: (option, active) =>
                    opt(option, option.disabled ? "disabled" : active ? "active" : "inactive"),
                  maxItems: opts.maxItems,
                  output: opts.output,
                });
          return [
            ...headings,
            ...displayOptions.map((option) => `${guidePrefix}${option}`),
            ...footers,
          ].join("\n");
        }
      }
    },
  });

  return prompt.prompt() as Promise<Value | symbol>;
}

export function textWithNavigationFooter(
  opts: TextOptions & NavigationPromptOptions,
): Promise<string | symbol> {
  return new TextPrompt({
    validate: opts.validate,
    placeholder: opts.placeholder,
    defaultValue: opts.defaultValue,
    initialValue: opts.initialValue,
    output: opts.output,
    signal: opts.signal,
    input: opts.input,
    render() {
      const showGuide = hasGuide(opts);
      const titlePrefix = `${showGuide ? `${styleText("gray", S_BAR)}\n` : ""}${clackSymbol(
        this.state,
      )}  `;
      const title = `${titlePrefix}${opts.message}\n`;
      const placeholder = opts.placeholder
        ? styleText("inverse", opts.placeholder[0] ?? "") +
          styleText("dim", opts.placeholder.slice(1))
        : styleText(["inverse", "hidden"], "_");
      const userInput = !this.userInput ? placeholder : this.userInputWithCursor;
      const value = this.value ?? "";

      switch (this.state) {
        case "error": {
          const errorText = this.error ? `  ${styleText("yellow", this.error)}` : "";
          const errorPrefix = showGuide ? `${styleText("yellow", S_BAR)}  ` : "";
          const errorPrefixEnd = showGuide ? styleText("yellow", S_BAR_END) : "";
          const footerLines = navigationFooterLines(showGuide, "yellow", opts.navigation);
          return `${title.trim()}\n${errorPrefix}${userInput}\n${
            footerLines.length ? `${footerLines.join("\n")}\n` : ""
          }${errorPrefixEnd}${errorText}\n`;
        }
        case "submit": {
          const valueText = value ? `  ${styleText("dim", value)}` : "";
          const submitPrefix = showGuide ? styleText("gray", S_BAR) : "";
          return `${title}${submitPrefix}${valueText}`;
        }
        case "cancel": {
          const valueText = value ? `  ${styleText(["strikethrough", "dim"], value)}` : "";
          const cancelPrefix = showGuide ? styleText("gray", S_BAR) : "";
          return `${title}${cancelPrefix}${valueText}${value.trim() ? `\n${cancelPrefix}` : ""}`;
        }
        default: {
          const defaultPrefix = showGuide ? `${styleText("cyan", S_BAR)}  ` : "";
          const defaultPrefixEnd = showGuide ? styleText("cyan", S_BAR_END) : "";
          const footerLines = navigationFooterLines(showGuide, "cyan", opts.navigation);
          return `${title}${defaultPrefix}${userInput}\n${
            footerLines.length ? `${footerLines.join("\n")}\n` : ""
          }${defaultPrefixEnd}\n`;
        }
      }
    },
  }).prompt() as Promise<string | symbol>;
}

export function passwordWithNavigationFooter(
  opts: PasswordOptions & NavigationPromptOptions,
): Promise<string | symbol> {
  return new PasswordPrompt({
    validate: opts.validate,
    mask: opts.mask ?? S_PASSWORD_MASK,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    render() {
      const showGuide = hasGuide(opts);
      const title = `${showGuide ? `${styleText("gray", S_BAR)}\n` : ""}${clackSymbol(
        this.state,
      )}  ${opts.message}\n`;
      const userInput = this.userInputWithCursor;
      const masked = this.masked;

      switch (this.state) {
        case "error": {
          const errorPrefix = showGuide ? `${styleText("yellow", S_BAR)}  ` : "";
          const errorPrefixEnd = showGuide ? `${styleText("yellow", S_BAR_END)}  ` : "";
          const maskedText = masked ?? "";
          if (opts.clearOnError) {
            this.clear();
          }
          const footerLines = navigationFooterLines(showGuide, "yellow", opts.navigation);
          return `${title.trim()}\n${errorPrefix}${maskedText}\n${
            footerLines.length ? `${footerLines.join("\n")}\n` : ""
          }${errorPrefixEnd}${styleText("yellow", this.error)}\n`;
        }
        case "submit": {
          const submitPrefix = showGuide ? `${styleText("gray", S_BAR)}  ` : "";
          const maskedText = masked ? styleText("dim", masked) : "";
          return `${title}${submitPrefix}${maskedText}`;
        }
        case "cancel": {
          const cancelPrefix = showGuide ? `${styleText("gray", S_BAR)}  ` : "";
          const maskedText = masked ? styleText(["strikethrough", "dim"], masked) : "";
          return `${title}${cancelPrefix}${maskedText}${
            masked && showGuide ? `\n${styleText("gray", S_BAR)}` : ""
          }`;
        }
        default: {
          const defaultPrefix = showGuide ? `${styleText("cyan", S_BAR)}  ` : "";
          const defaultPrefixEnd = showGuide ? styleText("cyan", S_BAR_END) : "";
          const footerLines = navigationFooterLines(showGuide, "cyan", opts.navigation);
          return `${title}${defaultPrefix}${userInput}\n${
            footerLines.length ? `${footerLines.join("\n")}\n` : ""
          }${defaultPrefixEnd}\n`;
        }
      }
    },
  }).prompt() as Promise<string | symbol>;
}

function multiselectOptionRenderer<Value>(
  option: PromptOption<Value>,
  state:
    | "inactive"
    | "active"
    | "selected"
    | "active-selected"
    | "submitted"
    | "cancelled"
    | "disabled",
): string {
  const label = getOptionLabel(option);
  if (state === "disabled") {
    return `${styleText("gray", S_CHECKBOX_INACTIVE)} ${computeLabel(label, (str) =>
      styleText(["strikethrough", "gray"], str),
    )}${option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""}`;
  }
  if (state === "active") {
    return `${styleText("cyan", S_CHECKBOX_ACTIVE)} ${label}${
      option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""
    }`;
  }
  if (state === "selected") {
    return `${styleText("green", S_CHECKBOX_SELECTED)} ${computeLabel(label, (text) =>
      styleText("dim", text),
    )}${option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""}`;
  }
  if (state === "cancelled") {
    return computeLabel(label, (text) => styleText(["strikethrough", "dim"], text));
  }
  if (state === "active-selected") {
    return `${styleText("green", S_CHECKBOX_SELECTED)} ${label}${
      option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""
    }`;
  }
  if (state === "submitted") {
    return computeLabel(label, (text) => styleText("dim", text));
  }
  return `${styleText("dim", S_CHECKBOX_INACTIVE)} ${computeLabel(label, (text) =>
    styleText("dim", text),
  )}`;
}

export function multiselectWithNavigationFooter<Value>(
  opts: MultiSelectOptions<Value> & NavigationPromptOptions,
): Promise<Value[] | symbol> {
  const required = opts.required ?? true;
  return new MultiSelectPrompt({
    options: opts.options as Array<PromptOption<Value>>,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    initialValues: opts.initialValues,
    required,
    cursorAt: opts.cursorAt,
    validate(selected: Value[] | undefined) {
      if (required && (selected === undefined || selected.length === 0)) {
        return `Please select at least one option.\n${styleText(
          "reset",
          styleText(
            "dim",
            `Press ${styleText(["gray", "bgWhite", "inverse"], " space ")} to select, ${styleText(
              "gray",
              styleText("bgWhite", styleText("inverse", " enter ")),
            )} to submit`,
          ),
        )}`;
      }
      return undefined;
    },
    render() {
      const showGuide = hasGuide(opts);
      const wrappedMessage = wrapTextWithPrefix(
        opts.output,
        opts.message,
        showGuide ? `${clackSymbolBar(this.state)}  ` : "",
        `${clackSymbol(this.state)}  `,
      );
      const title = `${showGuide ? `${styleText("gray", S_BAR)}\n` : ""}${wrappedMessage}\n`;
      const value = this.value ?? [];
      const styleOption = (option: PromptOption<Value>, active: boolean) => {
        if (option.disabled) {
          return multiselectOptionRenderer(option, "disabled");
        }
        const selected = value.includes(option.value);
        if (active && selected) {
          return multiselectOptionRenderer(option, "active-selected");
        }
        if (selected) {
          return multiselectOptionRenderer(option, "selected");
        }
        return multiselectOptionRenderer(option, active ? "active" : "inactive");
      };

      switch (this.state) {
        case "submit": {
          const submitText =
            this.options
              .filter(({ value: optionValue }) => value.includes(optionValue))
              .map((option) => multiselectOptionRenderer(option, "submitted"))
              .join(styleText("dim", ", ")) || styleText("dim", "none");
          const wrappedSubmitText = wrapTextWithPrefix(
            opts.output,
            submitText,
            showGuide ? `${styleText("gray", S_BAR)}  ` : "",
          );
          return `${title}${wrappedSubmitText}`;
        }
        case "cancel": {
          const label = this.options
            .filter(({ value: optionValue }) => value.includes(optionValue))
            .map((option) => multiselectOptionRenderer(option, "cancelled"))
            .join(styleText("dim", ", "));
          if (label.trim() === "") {
            return `${title}${styleText("gray", S_BAR)}`;
          }
          const wrappedLabel = wrapTextWithPrefix(
            opts.output,
            label,
            showGuide ? `${styleText("gray", S_BAR)}  ` : "",
          );
          return `${title}${wrappedLabel}${showGuide ? `\n${styleText("gray", S_BAR)}` : ""}`;
        }
        case "error": {
          const prefix = showGuide ? `${styleText("yellow", S_BAR)}  ` : "";
          const footer = this.error
            .split("\n")
            .map((line, index) =>
              index === 0
                ? `${showGuide ? `${styleText("yellow", S_BAR_END)}  ` : ""}${styleText(
                    "yellow",
                    line,
                  )}`
                : `   ${line}`,
            )
            .join("\n");
          const titleLineCount = title.split("\n").length;
          const footerLineCount = footer.split("\n").length + 1;
          return `${title}${prefix}${limitOptions({
            output: opts.output,
            options: this.options,
            cursor: this.cursor,
            maxItems: opts.maxItems,
            columnPadding: prefix.length,
            rowPadding: titleLineCount + footerLineCount,
            style: styleOption,
          }).join(`\n${prefix}`)}\n${footer}\n`;
        }
        default: {
          const prefix = showGuide ? `${styleText("cyan", S_BAR)}  ` : "";
          const footerLines = [
            ...navigationFooterLines(showGuide, "cyan", opts.navigation, [
              styleText("dim", "↑/↓ option"),
              styleText("dim", "space select"),
            ]),
            showGuide ? styleText("cyan", S_BAR_END) : "",
          ];
          const titleLineCount = title.split("\n").length;
          const footerLineCount = footerLines.length + 1;
          return `${title}${prefix}${limitOptions({
            output: opts.output,
            options: this.options,
            cursor: this.cursor,
            maxItems: opts.maxItems,
            columnPadding: prefix.length,
            rowPadding: titleLineCount + footerLineCount,
            style: styleOption,
          }).join(`\n${prefix}`)}\n${footerLines.join("\n")}\n`;
        }
      }
    },
  }).prompt() as Promise<Value[] | symbol>;
}

export function autocompleteMultiselectWithNavigationFooter<Value>(
  opts: AutocompleteMultiSelectOptions<Value> & NavigationPromptOptions,
): Promise<Value[] | symbol> {
  const formatOption = (
    option: PromptOption<Value>,
    active: boolean,
    selectedValues: Value[],
    focusedValue: Value | undefined,
  ) => {
    const isSelected = selectedValues.includes(option.value);
    const label = getOptionLabel(option);
    const hint =
      option.hint && focusedValue !== undefined && option.value === focusedValue
        ? styleText("dim", ` (${option.hint})`)
        : "";
    const checkbox = isSelected
      ? styleText("green", S_CHECKBOX_SELECTED)
      : styleText("dim", S_CHECKBOX_INACTIVE);

    if (option.disabled) {
      return `${styleText("gray", S_CHECKBOX_INACTIVE)} ${styleText(
        ["strikethrough", "gray"],
        label,
      )}`;
    }
    if (active) {
      return `${checkbox} ${label}${hint}`;
    }
    return `${checkbox} ${styleText("dim", label)}`;
  };

  const prompt = new AutocompletePrompt<PromptOption<Value>>({
    options: opts.options as Array<PromptOption<Value>>,
    multiple: true,
    placeholder: opts.placeholder,
    filter: adaptOptionFilter(opts.filter) ?? getFilteredOption,
    validate: () => {
      if (opts.required && prompt.selectedValues.length === 0) {
        return "Please select at least one item";
      }
      return undefined;
    },
    initialValue: opts.initialValues,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    render() {
      const showGuide = hasGuide(opts);
      const title = `${showGuide ? `${styleText("gray", S_BAR)}\n` : ""}${clackSymbol(
        this.state,
      )}  ${opts.message}\n`;
      const userInput = this.userInput;
      const showPlaceholder = userInput === "" && opts.placeholder !== undefined;
      const searchText =
        this.isNavigating || showPlaceholder
          ? styleText("dim", showPlaceholder ? (opts.placeholder ?? "") : userInput)
          : this.userInputWithCursor;
      const options = this.options;
      const matches =
        this.filteredOptions.length !== options.length
          ? styleText(
              "dim",
              ` (${this.filteredOptions.length} match${
                this.filteredOptions.length === 1 ? "" : "es"
              })`,
            )
          : "";

      switch (this.state) {
        case "submit": {
          return `${title}${showGuide ? `${styleText("gray", S_BAR)}  ` : ""}${styleText(
            "dim",
            `${this.selectedValues.length} items selected`,
          )}`;
        }
        case "cancel": {
          return `${title}${showGuide ? `${styleText("gray", S_BAR)}  ` : ""}${styleText(
            ["strikethrough", "dim"],
            userInput,
          )}`;
        }
        default: {
          const barStyle = this.state === "error" ? "yellow" : "cyan";
          const guidePrefix = showGuide ? `${styleText(barStyle, S_BAR)}  ` : "";
          const guidePrefixEnd = showGuide ? styleText(barStyle, S_BAR_END) : "";
          const instructions = [
            `${styleText("dim", "↑/↓")} to navigate`,
            `${styleText("dim", this.isNavigating ? "Space/Tab:" : "Tab:")} select`,
            `${styleText("dim", "Enter:")} confirm`,
            `${styleText("dim", "Type:")} to search`,
          ];
          const noResults =
            this.filteredOptions.length === 0 && userInput
              ? [`${guidePrefix}${styleText("yellow", "No matches found")}`]
              : [];
          const errorMessage =
            this.state === "error" ? [`${guidePrefix}${styleText("yellow", this.error)}`] : [];
          const headerLines = [
            ...`${title}${showGuide ? styleText(barStyle, S_BAR) : ""}`.split("\n"),
            `${guidePrefix}${styleText("dim", "Search:")} ${searchText}${matches}`,
            ...noResults,
            ...errorMessage,
          ];
          const footerLines = [
            `${guidePrefix}${instructions.join(" • ")}`,
            ...navigationFooterLines(showGuide, barStyle, opts.navigation),
            guidePrefixEnd,
          ];
          const displayOptions = limitOptions({
            cursor: this.cursor,
            options: this.filteredOptions,
            style: (option, active) =>
              formatOption(option, active, this.selectedValues, this.focusedValue),
            maxItems: opts.maxItems,
            output: opts.output,
            rowPadding: headerLines.length + footerLines.length,
          });

          return [
            ...headerLines,
            ...displayOptions.map((option) => `${guidePrefix}${option}`),
            ...footerLines,
          ].join("\n");
        }
      }
    },
  });

  return prompt.prompt() as Promise<Value[] | symbol>;
}

export function confirmWithNavigationFooter(
  opts: ConfirmOptions & NavigationPromptOptions,
): Promise<boolean | symbol> {
  const active = opts.active ?? "Yes";
  const inactive = opts.inactive ?? "No";
  return new ConfirmPrompt({
    active,
    inactive,
    signal: opts.signal,
    input: opts.input,
    output: opts.output,
    initialValue: opts.initialValue ?? true,
    render() {
      const showGuide = hasGuide(opts);
      const titlePrefix = `${clackSymbol(this.state)}  `;
      const titlePrefixBar = showGuide ? `${styleText("gray", S_BAR)}  ` : "";
      const messageLines = wrapTextWithPrefix(
        opts.output,
        opts.message,
        titlePrefixBar,
        titlePrefix,
      );
      const title = `${showGuide ? `${styleText("gray", S_BAR)}\n` : ""}${messageLines}\n`;
      const value = this.value ? active : inactive;

      switch (this.state) {
        case "submit": {
          const submitPrefix = showGuide ? `${styleText("gray", S_BAR)}  ` : "";
          return `${title}${submitPrefix}${styleText("dim", value)}`;
        }
        case "cancel": {
          const cancelPrefix = showGuide ? `${styleText("gray", S_BAR)}  ` : "";
          return `${title}${cancelPrefix}${styleText(["strikethrough", "dim"], value)}${
            showGuide ? `\n${styleText("gray", S_BAR)}` : ""
          }`;
        }
        default: {
          const defaultPrefix = showGuide ? `${styleText("cyan", S_BAR)}  ` : "";
          const defaultPrefixEnd = showGuide ? styleText("cyan", S_BAR_END) : "";
          const separator = opts.vertical
            ? showGuide
              ? `\n${styleText("cyan", S_BAR)}  `
              : "\n"
            : ` ${styleText("dim", "/")} `;
          const footerLines = navigationFooterLines(showGuide, "cyan", opts.navigation, [
            styleText("dim", "↑/↓ option"),
          ]);
          return `${title}${defaultPrefix}${
            this.value
              ? `${styleText("green", S_RADIO_ACTIVE)} ${active}`
              : `${styleText("dim", S_RADIO_INACTIVE)} ${styleText("dim", active)}`
          }${separator}${
            !this.value
              ? `${styleText("green", S_RADIO_ACTIVE)} ${inactive}`
              : `${styleText("dim", S_RADIO_INACTIVE)} ${styleText("dim", inactive)}`
          }\n${footerLines.length > 0 ? `${footerLines.join("\n")}\n` : ""}${defaultPrefixEnd}\n`;
        }
      }
    },
  }).prompt() as Promise<boolean | symbol>;
}
