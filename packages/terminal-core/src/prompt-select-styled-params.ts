// Terminal Core module implements prompt select styled params behavior.
import { stylePromptHint, stylePromptMessage } from "./prompt-style.js";

// Pure prompt parameter styler used by interactive prompts and tests.

/** Minimal select-like params accepted by the prompt styler. */
type SelectParamsLike = {
  message: string;
  options: readonly object[];
};

/** Styling callbacks for prompt messages and hints. */
type PromptSelectStylers = {
  message: (value: string) => string;
  hint: (value: string) => string | undefined;
};

/** Default terminal stylers for select prompts. */
const defaultStylers: PromptSelectStylers = {
  message: stylePromptMessage,
  hint: stylePromptHint,
};

/** Return select params with styled prompt message and per-option hints. */
export function styleSelectParams<TParams extends SelectParamsLike>(
  params: TParams,
  stylers: PromptSelectStylers = defaultStylers,
): TParams {
  return {
    ...params,
    message: stylers.message(params.message),
    options: params.options.map((opt) => {
      const hint = "hint" in opt && typeof opt.hint === "string" ? opt.hint : undefined;
      return hint === undefined ? opt : { ...opt, hint: stylers.hint(hint) };
    }),
  } as TParams;
}
