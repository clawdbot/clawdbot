import {
  formatDocsLink,
  promptAccountId,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ChannelOnboardingAdapter,
  type WizardPrompter,
} from "clawdbot/plugin-sdk";

import { listTlonAccountIds, resolveTlonAccount } from "./types.js";
import type { TlonResolvedAccount } from "./types.js";
import type { MoltbotConfig } from "clawdbot/plugin-sdk";

const channel = "tlon" as const;

function isConfigured(account: TlonResolvedAccount): boolean {
  return Boolean(account.ship && account.url && account.code);
}

function applyAccountConfig(params: {
  cfg: MoltbotConfig;
  accountId: string;
  input: {
    name?: string;
    ship?: string;
    url?: string;
    code?: string;
    groupChannels?: string[];
    dmAllowlist?: string[];
    autoDiscoverChannels?: boolean;
  };
}): MoltbotConfig {
  const { cfg, accountId, input } = params;
  const useDefault = accountId === DEFAULT_ACCOUNT_ID;
  const base = cfg.channels?.tlon ?? {};

  if (useDefault) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        tlon: {
          ...base,
          enabled: true,
          ...(input.name ? { name: input.name } : {}),
          ...(input.ship ? { ship: input.ship } : {}),
          ...(input.url ? { url: input.url } : {}),
          ...(input.code ? { code: input.code } : {}),
          ...(input.groupChannels ? { groupChannels: input.groupChannels } : {}),
          ...(input.dmAllowlist ? { dmAllowlist: input.dmAllowlist } : {}),
          ...(typeof input.autoDiscoverChannels === "boolean"
            ? { autoDiscoverChannels: input.autoDiscoverChannels }
            : {}),
        },
      },
    };
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      tlon: {
        ...base,
        enabled: base.enabled ?? true,
        accounts: {
          ...(base as { accounts?: Record<string, unknown> }).accounts,
          [accountId]: {
            ...((base as { accounts?: Record<string, Record<string, unknown>> }).accounts?.[accountId] ?? {}),
            enabled: true,
            ...(input.name ? { name: input.name } : {}),
            ...(input.ship ? { ship: input.ship } : {}),
            ...(input.url ? { url: input.url } : {}),
            ...(input.code ? { code: input.code } : {}),
            ...(input.groupChannels ? { groupChannels: input.groupChannels } : {}),
            ...(input.dmAllowlist ? { dmAllowlist: input.dmAllowlist } : {}),
            ...(typeof input.autoDiscoverChannels === "boolean"
              ? { autoDiscoverChannels: input.autoDiscoverChannels }
              : {}),
          },
        },
      },
    },
  };
}

async function noteTlonHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "You need your Urbit ship URL and login code.",
      "Example URL: https://your-ship-host",
      "Example ship: ~sampel-palnet",
      `Docs: ${formatDocsLink("/channels/tlon", "channels/tlon")}`,
    ].join("\n"),
    "Tlon setup",
  );
}

function parseList(value: string): string[] {
  return value
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const tlonOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const accountIds = listTlonAccountIds(cfg);
    const configured =
      accountIds.length > 0
        ? accountIds.some((accountId) => isConfigured(resolveTlonAccount(cfg, accountId)))
        : isConfigured(resolveTlonAccount(cfg, DEFAULT_ACCOUNT_ID));

    return {
      channel,
      configured,
      statusLines: [`Tlon: ${configured ? "configured" : "needs setup"}`],
      selectionHint: configured ? "configured" : "urbit messenger",
      quickstartScore: configured ? 1 : 4,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const override = accountOverrides[channel]?.trim();
    const defaultAccountId = DEFAULT_ACCOUNT_ID;
    let accountId = override ? normalizeAccountId(override) : defaultAccountId;

    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "Tlon",
        currentId: accountId,
        listAccountIds: listTlonAccountIds,
        defaultAccountId,
      });
    }

    const resolved = resolveTlonAccount(cfg, accountId);
    await noteTlonHelp(prompter);

    const ship = await prompter.text({
      message: "Ship name",
      placeholder: "~sampel-palnet",
      initialValue: resolved.ship ?? undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });

    const url = await prompter.text({
      message: "Ship URL",
      placeholder: "https://your-ship-host",
      initialValue: resolved.url ?? undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });

    const code = await prompter.text({
      message: "Login code",
      placeholder: "lidlut-tabwed-pillex-ridrup",
      initialValue: resolved.code ?? undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });

    const wantsGroupChannels = await prompter.confirm({
      message: "Add group channels manually? (optional)",
      initialValue: false,
    });

    let groupChannels: string[] | undefined;
    if (wantsGroupChannels) {
      const entry = await prompter.text({
        message: "Group channels (comma-separated)",
        placeholder: "chat/~host-ship/general, chat/~host-ship/support",
      });
      const parsed = parseList(String(entry ?? ""));
      groupChannels = parsed.length > 0 ? parsed : undefined;
    }

    const wantsAllowlist = await prompter.confirm({
      message: "Restrict DMs with an allowlist?",
      initialValue: false,
    });

    let dmAllowlist: string[] | undefined;
    if (wantsAllowlist) {
      const entry = await prompter.text({
        message: "DM allowlist (comma-separated ship names)",
        placeholder: "~zod, ~nec",
      });
      const parsed = parseList(String(entry ?? ""));
      dmAllowlist = parsed.length > 0 ? parsed : undefined;
    }

    const autoDiscoverChannels = await prompter.confirm({
      message: "Enable auto-discovery of group channels?",
      initialValue: resolved.autoDiscoverChannels ?? true,
    });

    const next = applyAccountConfig({
      cfg,
      accountId,
      input: {
        ship: String(ship).trim(),
        url: String(url).trim(),
        code: String(code).trim(),
        groupChannels,
        dmAllowlist,
        autoDiscoverChannels,
      },
    });

    return { cfg: next, accountId };
  },
};
