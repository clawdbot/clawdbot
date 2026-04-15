import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export type WhatsAppAccountConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>["accounts"]
>[string];
