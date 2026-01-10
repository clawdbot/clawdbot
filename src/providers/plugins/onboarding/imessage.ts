import { detectBinary } from "../../../commands/onboard-helpers.js";
import type { ClawdbotConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import {
  listIMessageAccountIds,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
} from "../../../imessage/accounts.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type {
  ProviderOnboardingAdapter,
  ProviderOnboardingDmPolicy,
} from "../onboarding-types.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const provider = "imessage" as const;

function setIMessageDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.imessage?.allowFrom)
      : undefined;
  return {
    ...cfg,
    imessage: {
      ...cfg.imessage,
      dmPolicy,
      ...(allowFrom ? { allowFrom } : {}),
    },
  };
}

const dmPolicy: ProviderOnboardingDmPolicy = {
  label: "iMessage",
  provider,
  policyKey: "imessage.dmPolicy",
  allowFromKey: "imessage.allowFrom",
  getCurrent: (cfg) => cfg.imessage?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setIMessageDmPolicy(cfg, policy),
};

export const imessageOnboardingAdapter: ProviderOnboardingAdapter = {
  provider,
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
    const imessageCliPath = cfg.imessage?.cliPath ?? "imsg";
    const imessageCliDetected = await detectBinary(imessageCliPath);
    return {
      provider,
      configured,
      statusLines: [
        `iMessage: ${configured ? "configured" : "needs setup"}`,
        `imsg: ${imessageCliDetected ? "found" : "missing"} (${imessageCliPath})`,
      ],
      selectionHint: imessageCliDetected ? "imsg found" : "imsg missing",
      quickstartScore: imessageCliDetected ? 1 : 0,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
  }) => {
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
        await prompter.note(
          "imsg CLI path required to enable iMessage.",
          "iMessage",
        );
      }
    }

    if (resolvedCliPath) {
      if (imessageAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          imessage: {
            ...next.imessage,
            enabled: true,
            cliPath: resolvedCliPath,
          },
        };
      } else {
        next = {
          ...next,
          imessage: {
            ...next.imessage,
            enabled: true,
            accounts: {
              ...next.imessage?.accounts,
              [imessageAccountId]: {
                ...next.imessage?.accounts?.[imessageAccountId],
                enabled:
                  next.imessage?.accounts?.[imessageAccountId]?.enabled ?? true,
                cliPath: resolvedCliPath,
              },
            },
          },
        };
      }
    }

    await prompter.note(
      [
        "This is still a work in progress.",
        "Ensure Clawdbot has Full Disk Access to Messages DB.",
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
    imessage: { ...cfg.imessage, enabled: false },
  }),
};
