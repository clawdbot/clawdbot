// Discord type declarations define plugin contracts.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordLivePolicyReader } from "./live-policy.js";
import type { DiscordDispatchReplyFromConfig } from "./native-command.types.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];

export type DiscordCommandArgContext = {
  readPolicy?: DiscordLivePolicyReader;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  threadBindings: ThreadBindingManager;
  dispatchReplyFromConfig?: DiscordDispatchReplyFromConfig;
  postApplySettleMs?: number;
};

export type DiscordModelPickerContext = DiscordCommandArgContext;

export type SafeDiscordInteractionCall = <T>(
  label: string,
  fn: () => Promise<T>,
) => Promise<T | null>;
