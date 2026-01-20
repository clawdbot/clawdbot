import type { ClawdbotConfig, DmPolicy, WizardPrompter } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "clawdbot/plugin-sdk";
import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
} from "../../../src/channels/plugins/onboarding-types.js";
import { addWildcardAllowFrom, promptAccountId } from "../../../src/channels/plugins/onboarding/helpers.js";
import { formatDocsLink } from "../../../src/terminal/links.js";
import {
  listBlueBubblesAccountIds,
  resolveBlueBubblesAccount,
  resolveDefaultBlueBubblesAccountId,
} from "./accounts.js";
import { normalizeBlueBubblesServerUrl } from "./types.js";
import { parseBlueBubblesAllowTarget, normalizeBlueBubblesHandle } from "./targets.js";

const channel = "bluebubbles" as const;

function setBlueBubblesDmPolicy(cfg: ClawdbotConfig, dmPolicy: DmPolicy): ClawdbotConfig {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.bluebubbles?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      bluebubbles: {
        ...cfg.channels?.bluebubbles,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setBlueBubblesAllowFrom(
  cfg: ClawdbotConfig,
  accountId: string,
  allowFrom: string[],
): ClawdbotConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        bluebubbles: {
          ...cfg.channels?.bluebubbles,
          allowFrom,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      bluebubbles: {
        ...cfg.channels?.bluebubbles,
        accounts: {
          ...cfg.channels?.bluebubbles?.accounts,
          [accountId]: {
            ...cfg.channels?.bluebubbles?.accounts?.[accountId],
            allowFrom,
          },
        },
      },
    },
  };
}

function parseBlueBubblesAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptBlueBubblesAllowFrom(params: {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<ClawdbotConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultBlueBubblesAccountId(params.cfg);
  const resolved = resolveBlueBubblesAccount({ cfg: params.cfg, accountId });
  const existing = resolved.config.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist BlueBubbles DMs by handle or chat target.",
      "Examples:",
      "- +15555550123",
      "- user@example.com",
      "- chat_id:123",
      "- chat_guid:iMessage;-;+15555550123",
      "Multiple entries: comma- or newline-separated.",
      `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
    ].join("\n"),
    "BlueBubbles allowlist",
  );
  const entry = await params.prompter.text({
    message: "BlueBubbles allowFrom (handle or chat_id)",
    placeholder: "+15555550123, user@example.com, chat_id:123",
    initialValue: existing[0] ? String(existing[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return "Required";
      const parts = parseBlueBubblesAllowFromInput(raw);
      for (const part of parts) {
        if (part === "*") continue;
        const parsed = parseBlueBubblesAllowTarget(part);
        if (parsed.kind === "handle" && !parsed.handle) {
          return `Invalid entry: ${part}`;
        }
      }
      return undefined;
    },
  });
  const parts = parseBlueBubblesAllowFromInput(String(entry));
  const unique = [...new Set(parts)];
  return setBlueBubblesAllowFrom(params.cfg, accountId, unique);
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "BlueBubbles",
  channel,
  policyKey: "channels.bluebubbles.dmPolicy",
  allowFromKey: "channels.bluebubbles.allowFrom",
  getCurrent: (cfg) => cfg.channels?.bluebubbles?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setBlueBubblesDmPolicy(cfg, policy),
  promptAllowFrom: promptBlueBubblesAllowFrom,
};

export const blueBubblesOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listBlueBubblesAccountIds(cfg).some((accountId) => {
      const account = resolveBlueBubblesAccount({ cfg, accountId });
      return account.configured;
    });
    return {
      channel,
      configured,
      statusLines: [`BlueBubbles: ${configured ? "configured" : "needs setup"}`],
      selectionHint: configured ? "configured" : "iMessage via BlueBubbles app",
      quickstartScore: configured ? 1 : 0,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const blueBubblesOverride = accountOverrides.bluebubbles?.trim();
    const defaultAccountId = resolveDefaultBlueBubblesAccountId(cfg);
    let accountId = blueBubblesOverride
      ? normalizeAccountId(blueBubblesOverride)
      : defaultAccountId;
    if (shouldPromptAccountIds && !blueBubblesOverride) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "BlueBubbles",
        currentId: accountId,
        listAccountIds: listBlueBubblesAccountIds,
        defaultAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveBlueBubblesAccount({ cfg: next, accountId });

    // Prompt for server URL
    let serverUrl = resolvedAccount.config.serverUrl?.trim();
    if (!serverUrl) {
      await prompter.note(
        [
          "Enter the BlueBubbles server URL (e.g., http://192.168.1.100:1234).",
          "Find this in the BlueBubbles Server app under Connection.",
          `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
        ].join("\n"),
        "BlueBubbles server URL",
      );
      const entered = await prompter.text({
        message: "BlueBubbles server URL",
        placeholder: "http://192.168.1.100:1234",
        validate: (value) => {
          const trimmed = String(value ?? "").trim();
          if (!trimmed) return "Required";
          try {
            const normalized = normalizeBlueBubblesServerUrl(trimmed);
            new URL(normalized);
            return undefined;
          } catch {
            return "Invalid URL format";
          }
        },
      });
      serverUrl = String(entered).trim();
    } else {
      const keepUrl = await prompter.confirm({
        message: `BlueBubbles server URL already set (${serverUrl}). Keep it?`,
        initialValue: true,
      });
      if (!keepUrl) {
        const entered = await prompter.text({
          message: "BlueBubbles server URL",
          placeholder: "http://192.168.1.100:1234",
          initialValue: serverUrl,
          validate: (value) => {
            const trimmed = String(value ?? "").trim();
            if (!trimmed) return "Required";
            try {
              const normalized = normalizeBlueBubblesServerUrl(trimmed);
              new URL(normalized);
              return undefined;
            } catch {
              return "Invalid URL format";
            }
          },
        });
        serverUrl = String(entered).trim();
      }
    }

    // Prompt for password
    let password = resolvedAccount.config.password?.trim();
    if (!password) {
      await prompter.note(
        [
          "Enter the BlueBubbles server password.",
          "Find this in the BlueBubbles Server app under Settings.",
        ].join("\n"),
        "BlueBubbles password",
      );
      const entered = await prompter.text({
        message: "BlueBubbles password",
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      });
      password = String(entered).trim();
    } else {
      const keepPassword = await prompter.confirm({
        message: "BlueBubbles password already set. Keep it?",
        initialValue: true,
      });
      if (!keepPassword) {
        const entered = await prompter.text({
          message: "BlueBubbles password",
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        });
        password = String(entered).trim();
      }
    }

    // Prompt for webhook path (optional)
    const existingWebhookPath = resolvedAccount.config.webhookPath?.trim();
    const wantsWebhook = await prompter.confirm({
      message: "Configure a custom webhook path? (default: /bluebubbles-webhook)",
      initialValue: Boolean(existingWebhookPath && existingWebhookPath !== "/bluebubbles-webhook"),
    });
    let webhookPath = "/bluebubbles-webhook";
    if (wantsWebhook) {
      const entered = await prompter.text({
        message: "Webhook path",
        placeholder: "/bluebubbles-webhook",
        initialValue: existingWebhookPath || "/bluebubbles-webhook",
        validate: (value) => {
          const trimmed = String(value ?? "").trim();
          if (!trimmed) return "Required";
          if (!trimmed.startsWith("/")) return "Path must start with /";
          return undefined;
        },
      });
      webhookPath = String(entered).trim();
    }

    // Apply config
    if (accountId === DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          bluebubbles: {
            ...next.channels?.bluebubbles,
            enabled: true,
            serverUrl,
            password,
            webhookPath,
          },
        },
      };
    } else {
      next = {
        ...next,
        channels: {
          ...next.channels,
          bluebubbles: {
            ...next.channels?.bluebubbles,
            enabled: true,
            accounts: {
              ...next.channels?.bluebubbles?.accounts,
              [accountId]: {
                ...next.channels?.bluebubbles?.accounts?.[accountId],
                enabled: next.channels?.bluebubbles?.accounts?.[accountId]?.enabled ?? true,
                serverUrl,
                password,
                webhookPath,
              },
            },
          },
        },
      };
    }

    await prompter.note(
      [
        "Configure the webhook URL in BlueBubbles Server:",
        "1. Open BlueBubbles Server → Settings → Webhooks",
        "2. Add your Clawdbot gateway URL + webhook path",
        "   Example: https://your-gateway-host:3000/bluebubbles-webhook",
        "3. Enable the webhook and save",
        "",
        `Docs: ${formatDocsLink("/channels/bluebubbles", "bluebubbles")}`,
      ].join("\n"),
      "BlueBubbles next steps",
    );

    return { cfg: next, accountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      bluebubbles: { ...cfg.channels?.bluebubbles, enabled: false },
    },
  }),
};
