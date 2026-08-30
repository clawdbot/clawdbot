// Signal plugin module implements account types behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

type SignalChannelConfig = Exclude<NonNullable<OpenClawConfig["channels"]>["signal"], undefined>;

export type SignalAccountConfig = Omit<SignalChannelConfig, "accounts" | "defaultAccount">;

export type SignalTransportConfig = NonNullable<SignalChannelConfig["transport"]>;
