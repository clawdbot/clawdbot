import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export type SignalAccountConfig = Omit<
  Exclude<NonNullable<OpenClawConfig["channels"]>["signal"], undefined>,
  "accounts"
>;
