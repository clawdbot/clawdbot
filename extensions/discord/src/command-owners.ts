import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export function resolveDiscordCommandOwnerEntries(cfg: OpenClawConfig): string[] | undefined {
  // Doctor owns channel:user:id repair. Bare targets (user:, pk:, mentions) are
  // shipped owner config; keep their matcher without re-reading the retired envelope.
  // An unrepaired Discord override stays empty instead of inheriting channel access.
  const entries = (cfg.commands?.ownerAllowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter((entry) => entry && (/^(discord|user|pk):/i.test(entry) || !entry.includes(":")));
  return entries.length > 0 ? entries.filter((entry) => !/^discord:user:/i.test(entry)) : undefined;
}

export function resolveDiscordCommandOwnerAllowFrom(cfg: OpenClawConfig): string[] | undefined {
  return resolveDiscordCommandOwnerEntries(cfg)
    ?.map((entry) => entry.replace(/^discord:/i, "").trim())
    .filter(Boolean);
}
