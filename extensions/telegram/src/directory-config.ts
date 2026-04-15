import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { createInspectedDirectoryEntriesLister } from "openclaw/plugin-sdk/directory-runtime";
import { inspectTelegramAccount, type InspectedTelegramAccount } from "./account-inspect.js";

export const listTelegramDirectoryPeersFromConfig =
  createInspectedDirectoryEntriesLister<InspectedTelegramAccount>({
    kind: "user",
    inspectAccount: (cfg, accountId) =>
      inspectTelegramAccount({ cfg, accountId }) as InspectedTelegramAccount | null,
    resolveSources: (account) => [
      mapAllowFromEntries(account.config.allowFrom),
      Object.keys(account.config.dms ?? {}),
    ],
    normalizeId: (entry) => {
      const trimmed = entry.replace(/^(telegram|tg):/i, "").trim();
      if (!trimmed) {
        return null;
      }
      if (/^-?\d+$/.test(trimmed)) {
        return trimmed;
      }
      return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
    },
  });

export const listTelegramDirectoryGroupsFromConfig =
  createInspectedDirectoryEntriesLister<InspectedTelegramAccount>({
    kind: "group",
    inspectAccount: (cfg, accountId) =>
      inspectTelegramAccount({ cfg, accountId }) as InspectedTelegramAccount | null,
    resolveSources: (account) => [Object.keys(account.config.groups ?? {})],
    normalizeId: (entry) => entry.trim() || null,
  });
