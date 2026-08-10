/** Lightweight reply-option contract for prepared plugin command ownership. */
export const PLUGIN_COMMAND_DISPATCH: unique symbol = Symbol.for(
  "openclaw.pluginCommandDispatch",
) as never;

type PluginCommandReplyDecision = Readonly<{ kind: "plugin" | "non-plugin" }>;

export type PluginCommandReplyOptionCarrier<
  TDecision extends PluginCommandReplyDecision = PluginCommandReplyDecision,
> = Readonly<{
  [PLUGIN_COMMAND_DISPATCH]?: TDecision;
}>;
