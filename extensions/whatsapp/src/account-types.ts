// Whatsapp plugin module implements account types behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type WhatsAppAccountConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>["accounts"]
>[string];
