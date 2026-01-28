import type { MoltbotConfig } from "clawdbot/plugin-sdk";

export type TlonResolvedAccount = {
  accountId: string;
  name: string | null;
  enabled: boolean;
  configured: boolean;
  ship: string | null;
  url: string | null;
  code: string | null;
  groupChannels: string[];
  dmAllowlist: string[];
  autoDiscoverChannels: boolean | null;
  showModelSignature: boolean | null;
};

export function resolveTlonAccount(cfg: MoltbotConfig, accountId?: string | null): TlonResolvedAccount {
  const base = cfg.channels?.tlon as
    | {
        name?: string;
        enabled?: boolean;
        ship?: string;
        url?: string;
        code?: string;
        groupChannels?: string[];
        dmAllowlist?: string[];
        autoDiscoverChannels?: boolean;
        showModelSignature?: boolean;
        accounts?: Record<string, Record<string, unknown>>;
      }
    | undefined;

  if (!base) {
    return {
      accountId: accountId || "default",
      name: null,
      enabled: false,
      configured: false,
      ship: null,
      url: null,
      code: null,
      groupChannels: [],
      dmAllowlist: [],
      autoDiscoverChannels: null,
      showModelSignature: null,
    };
  }

  const useDefault = !accountId || accountId === "default";
  const account = useDefault ? base : (base.accounts?.[accountId] as Record<string, unknown> | undefined);

  const ship = (account?.ship ?? base.ship ?? null) as string | null;
  const url = (account?.url ?? base.url ?? null) as string | null;
  const code = (account?.code ?? base.code ?? null) as string | null;
  const groupChannels = (account?.groupChannels ?? base.groupChannels ?? []) as string[];
  const dmAllowlist = (account?.dmAllowlist ?? base.dmAllowlist ?? []) as string[];
  const autoDiscoverChannels =
    (account?.autoDiscoverChannels ?? base.autoDiscoverChannels ?? null) as boolean | null;
  const showModelSignature =
    (account?.showModelSignature ?? base.showModelSignature ?? null) as boolean | null;
  const configured = Boolean(ship && url && code);

  return {
    accountId: accountId || "default",
    name: (account?.name ?? base.name ?? null) as string | null,
    enabled: (account?.enabled ?? base.enabled ?? true) !== false,
    configured,
    ship,
    url,
    code,
    groupChannels,
    dmAllowlist,
    autoDiscoverChannels,
    showModelSignature,
  };
}

export function listTlonAccountIds(cfg: MoltbotConfig): string[] {
  const base = cfg.channels?.tlon as
    | { ship?: string; accounts?: Record<string, Record<string, unknown>> }
    | undefined;
  if (!base) return [];
  const accounts = base.accounts ?? {};
  return [...(base.ship ? ["default"] : []), ...Object.keys(accounts)];
}
