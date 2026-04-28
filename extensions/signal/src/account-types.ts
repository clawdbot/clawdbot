import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";

export type SignalAccountConfig = Omit<
  Exclude<NonNullable<OpenClawConfig["channels"]>["signal"], undefined>,
  "accounts"
>;
