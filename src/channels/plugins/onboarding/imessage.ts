import { detectBinary } from "../../../commands/onboard-helpers.js";
import type { MoltbotConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "../../../imessage/accounts.js";
import { normalizeIMessageHandle } from "../../../imessage/targets.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const channel = "imessage" as const;

function setIMessageDmPolicy(cfg: MoltbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.imessage?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      imessage: {
        ...cfg.channels?.imessage,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setIMessageAllowFrom(
  cfg: MoltbotConfig,
  accountId: string,
  allowFrom: string[],
): MoltbotConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        imessage: {
          ...cfg.channels?.imessage,
          allowFrom,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      imessage: {
        ...cfg.channels?.imessage,
        accounts: {
          ...cfg.channels?.imessage?.accounts,
          [accountId]: {
            ...cfg.channels?.imessage?.accounts?.[accountId],
            allowFrom,
          },
        },
      },
    },
  };
}

function parseIMessageAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptIMessageAllowFrom(params: {
  cfg: MoltbotConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<MoltbotConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultIMessageAccountId(params.cfg);
  const resolved = resolveIMessageAccount({ cfg: params.cfg, accountId });
  const existing = resolved.config.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist iMessage DMs by handle or chat target.",
      "Examples:",
      "- +15555550123",
      "- user@example.com",
      "- chat_id:123",
      "- chat_guid:... or chat_identifier:...",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/imessage", "imessage")}`,
    ].join("\n"),
    "iMessage allowlist",
  );
  const entry = await params.prompter.text({
    message: "iMessage allowFrom (handle or chat_id)",
    placeholder: "+15555550123, user@example.com, chat_id:123",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return "Required";
      const parts = parseIMessageAllowFromInput(raw);
      for (const part of parts) {
        if (part === "*") continue;
        if (part.toLowerCase().startsWith("chat_id:")) {
          const id = part.slice("chat_id:".length).trim();
          if (!/^\d+$/.test(id)) return `Invalid chat_id: ${part}`;
          continue;
        }
        if (part.toLowerCase().startsWith("chat_guid:")) {
          if (!part.slice("chat_guid:".length).trim()) return "Invalid chat_guid entry";
          continue;
        }
        if (part.toLowerCase().startsWith("chat_identifier:")) {
          if (!part.slice("chat_identifier:".length).trim()) return "Invalid chat_identifier entry";
          continue;
        }
        if (!normalizeIMessageHandle(part)) return `Invalid handle: ${part}`;
      }
      return undefined;
    },
  });
  const parts = parseIMessageAllowFromInput(String(entry));
  const unique = [...new Set(parts)];
  return setIMessageAllowFrom(params.cfg, accountId, unique);
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "iMessage",
  channel,
  policyKey: "channels.imessage.dmPolicy",
  allowFromKey: "channels.imessage.allowFrom",
  getCurrent: (cfg) => cfg.channels?.imessage?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setIMessageDmPolicy(cfg, policy),
  promptAllowFrom: promptIMessageAllowFrom,
};

export const imessageOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listIMessageAccountIds(cfg).some((accountId) => {
      const account = resolveIMessageAccount({ cfg, accountId });
      return Boolean(
        account.config.cliPath ||
        account.config.dbPath ||
        account.config.allowFrom ||
        account.config.service ||
        account.config.region,
      );
    });
    const imessageCliPath = cfg.channels?.imessage?.cliPath ?? "imsg";
    const imessageCliDetected = await detectBinary(imessageCliPath);
    return {
      channel,
      configured,
      statusLines: [
        `iMessage: ${configured ? "configured" : "needs setup"}`,
        `imsg: ${imessageCliDetected ? "found" : "missing"} (${imessageCliPath})`,
      ],
      selectionHint: imessageCliDetected ? "imsg found" : "imsg missing",
      quickstartScore: imessageCliDetected ? 1 : 0,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const imessageOverride = accountOverrides.imessage?.trim();
    const defaultIMessageAccountId = resolveDefaultIMessageAccountId(cfg);
    let imessageAccountId = imessageOverride
      ? normalizeAccountId(imessageOverride)
      : defaultIMessageAccountId;
    if (shouldPromptAccountIds && !imessageOverride) {
      imessageAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "iMessage",
        currentId: imessageAccountId,
        listAccountIds: listIMessageAccountIds,
        defaultAccountId: defaultIMessageAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveIMessageAccount({
      cfg: next,
      accountId: imessageAccountId,
    });
    let resolvedCliPath = resolvedAccount.config.cliPath ?? "imsg";
    const cliDetected = await detectBinary(resolvedCliPath);
    if (!cliDetected) {
      const entered = await prompter.text({
        message: "imsg CLI path",
        initialValue: resolvedCliPath,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      });
      resolvedCliPath = String(entered).trim();
      if (!resolvedCliPath) {
        await prompter.note("imsg CLI path required to enable iMessage.", "iMessage");
      }
    }

    if (resolvedCliPath) {
      if (imessageAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            imessage: {
              ...next.channels?.imessage,
              enabled: true,
              cliPath: resolvedCliPath,
            },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            imessage: {
              ...next.channels?.imessage,
              enabled: true,
              accounts: {
                ...next.channels?.imessage?.accounts,
                [imessageAccountId]: {
                  ...next.channels?.imessage?.accounts?.[imessageAccountId],
                  enabled: next.channels?.imessage?.accounts?.[imessageAccountId]?.enabled ?? true,
                  cliPath: resolvedCliPath,
                },
              },
            },
          },
        };
      }
    }

    await prompter.note(
      [
        "This is still a work in progress.",
        "Ensure Moltbot has Full Disk Access to Messages DB.",
        "Grant Automation permission for Messages when prompted.",
        "List chats with: imsg chats --limit 20",
        `Docs: ${formatDocsLink("/imessage", "imessage")}`,
      ].join("\n"),
      "iMessage next steps",
    );

    return { cfg: next, accountId: imessageAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      imessage: { ...cfg.channels?.imessage, enabled: false },
    },
  }),
};
