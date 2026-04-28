import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { parseAndResolveDiscordTarget } from "./target-resolver.js";
import type { DiscordTargetParseOptions } from "./targets.js";

type DiscordRecipient =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

export async function parseAndResolveRecipient(
  raw: string,
  cfg: OpenClawConfig,
  accountId?: string,
  parseOptions: DiscordTargetParseOptions = {},
): Promise<DiscordRecipient> {
  if (!cfg) {
    throw new Error(
      "Discord recipient resolution requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const resolvedCfg = requireRuntimeConfig(cfg, "Discord recipient resolution");
  const accountInfo = resolveDiscordAccount({ cfg: resolvedCfg, accountId });
  const resolved = await parseAndResolveDiscordTarget(
    raw,
    {
      cfg: resolvedCfg,
      accountId: accountInfo.accountId,
    },
    parseOptions,
  );
  return { kind: resolved.kind, id: resolved.id };
}
