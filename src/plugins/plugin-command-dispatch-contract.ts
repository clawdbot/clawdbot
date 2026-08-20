/** Lightweight reply-option contract for prepared plugin command ownership. */
export const PLUGIN_COMMAND_DISPATCH: unique symbol = Symbol.for(
  "openclaw.pluginCommandDispatch",
) as never;

export type PluginCommandReplyOptions = Readonly<{
  [PLUGIN_COMMAND_DISPATCH]?: Readonly<{ kind: "plugin" | "non-plugin" }>;
}>;
