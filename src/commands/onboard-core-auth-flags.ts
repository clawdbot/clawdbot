/** Core auth flag registry for onboarding CLI help and routing. */
import type { AuthChoice, OnboardOptions } from "./onboard-types.js";

type OnboardCoreAuthOptionKey = Extract<keyof OnboardOptions, string>;

type OnboardCoreAuthFlag = {
  optionKey: OnboardCoreAuthOptionKey;
  authChoice: AuthChoice;
  cliFlag: `--${string}`;
  cliOption: `--${string} <key>`;
  description: string;
};

/** Auth-related CLI flags owned by core onboarding rather than provider plugins. */
export const CORE_ONBOARD_AUTH_FLAGS: ReadonlyArray<OnboardCoreAuthFlag> = [];

type RegisteredProviderAuthFlag = { optionKey: string; authChoice: string; cliFlag: string };
const REGISTERED_PROVIDER_AUTH_FLAGS = Symbol("registeredProviderAuthFlags");

/** Carry the parser's accepted flags across option spreads without adding a config/JSON key. */
export function withRegisteredProviderAuthFlags<T extends object>(
  options: T,
  flags: readonly RegisteredProviderAuthFlag[],
): T {
  return Object.assign(options, { [REGISTERED_PROVIDER_AUTH_FLAGS]: flags });
}

export function getRegisteredProviderAuthFlags(options: object) {
  // SAFETY: Only the typed setter above attaches this private symbol, including across option spreads.
  return (options as { [REGISTERED_PROVIDER_AUTH_FLAGS]?: readonly RegisteredProviderAuthFlag[] })[
    REGISTERED_PROVIDER_AUTH_FLAGS
  ];
}
