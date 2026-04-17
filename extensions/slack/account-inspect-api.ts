import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { inspectSlackAccount } from "./src/account-inspect.js";

export function inspectSlackReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null) {
  return inspectSlackAccount({ cfg, accountId });
}
