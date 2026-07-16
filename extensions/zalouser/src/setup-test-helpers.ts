import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import type { OpenClawConfig } from "../runtime-api.js";
import {
  listZalouserAccountIds,
  resolveDefaultZalouserAccountId,
  resolveZalouserAccountSync,
} from "./accounts.js";
import { zalouserSetupAdapter } from "./setup-core.js";
import { zalouserSetupWizard } from "./setup-surface.js";

export const zalouserSetupPlugin = {
  id: "zalouser",
  meta: {
    id: "zalouser",
    label: "ZaloUser",
    selectionLabel: "ZaloUser",
    docsPath: "/channels/zalouser",
    blurb: "Unofficial Zalo personal account connector.",
  },
  capabilities: {
    chatTypes: ["direct", "group"] as Array<"direct" | "group">,
  },
  config: {
    listAccountIds: (cfg: unknown) => listZalouserAccountIds(cfg as never),
    defaultAccountId: (cfg: unknown) => resolveDefaultZalouserAccountId(cfg as never),
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
      resolveZalouserAccountSync({ cfg, accountId }),
  },
  security: {
    resolveDmPolicy: createScopedDmSecurityResolver({
      channelKey: "zalouser",
      resolvePolicy: (account: ReturnType<typeof resolveZalouserAccountSync>) =>
        account.config.dmPolicy,
      resolveAllowFrom: (account: ReturnType<typeof resolveZalouserAccountSync>) =>
        account.config.allowFrom,
      policyPathSuffix: "dmPolicy",
      normalizeEntry: (raw: string) => raw.trim().replace(/^(zalouser|zlu):/i, ""),
    }),
  },
  setup: zalouserSetupAdapter,
  setupWizard: zalouserSetupWizard,
} as const;
