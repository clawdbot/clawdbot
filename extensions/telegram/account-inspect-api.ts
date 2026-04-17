import type { OpenClawConfig } from "./runtime-api.js";
import { inspectTelegramAccount } from "./src/account-inspect.js";

export function inspectTelegramReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null) {
  return inspectTelegramAccount({ cfg, accountId });
}
