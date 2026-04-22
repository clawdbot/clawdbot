import { requireRuntimeConfig, type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { parseAndResolveDiscordTarget } from "./target-resolver.js";

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
  accountId?: string,
  cfg?: OpenClawConfig,
): Promise<DiscordRecipient> {
  if (!cfg) {
    throw new Error(
      "Discord recipient resolution requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const resolvedCfg = requireRuntimeConfig(cfg, "Discord recipient resolution");
  const accountInfo = resolveDiscordAccount({ cfg: resolvedCfg, accountId });
  const trimmed = raw.trim();
  const parseOptions = {
    ambiguousMessage: `Ambiguous Discord recipient "${trimmed}". Use "user:${trimmed}" for DMs or "channel:${trimmed}" for channel messages.`,
  };
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
