import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { inspectDiscordAccount } from "./src/account-inspect.js";

export function inspectDiscordReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null) {
  return inspectDiscordAccount({ cfg, accountId });
}
