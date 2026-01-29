import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  MoltbotConfig,
  DmPolicy,
  WizardPrompter,
} from "clawdbot/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  promptChannelAccessConfig,
} from "clawdbot/plugin-sdk";

import { resolveZoomCredentials } from "./token.js";
import type { ZoomConfig } from "./types.js";

const channel = "zoom" as const;

function setZoomDmPolicy(cfg: MoltbotConfig, dmPolicy: DmPolicy) {
  const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(zoomCfg?.allowFrom)?.map((entry) => String(entry))
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zoom: {
        ...zoomCfg,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setZoomAllowFrom(cfg: MoltbotConfig, allowFrom: string[]): MoltbotConfig {
  const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zoom: {
        ...zoomCfg,
        allowFrom,
      },
    },
  };
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptZoomAllowFrom(params: {
  cfg: MoltbotConfig;
  prompter: WizardPrompter;
}): Promise<MoltbotConfig> {
  const zoomCfg = params.cfg.channels?.zoom as ZoomConfig | undefined;
  const existing = zoomCfg?.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist Zoom Team Chat DMs by user JID or email.",
      "Examples:",
      "- user@example.com",
      "- abcd1234@xmpp.zoom.us",
    ].join("\n"),
    "Zoom allowlist",
  );

  while (true) {
    const entry = await params.prompter.text({
      message: "Zoom allowFrom (user JIDs or emails)",
      placeholder: "user@example.com",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseAllowFromInput(String(entry));
    if (parts.length === 0) {
      await params.prompter.note("Enter at least one user.", "Zoom allowlist");
      continue;
    }

    const unique = [
      ...new Set([...existing.map((v) => String(v).trim()).filter(Boolean), ...parts]),
    ];
    return setZoomAllowFrom(params.cfg, unique);
  }
}

async function noteZoomCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Create a Team Chat app in Zoom Marketplace",
      "2) Enable Team Chat feature to get Bot JID",
      "3) Add required scopes: imchat:bot",
      "4) Copy Client ID, Client Secret, Account ID, Bot JID",
      "5) Configure webhook URL and secret token",
      "Tip: you can also set ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET / ZOOM_ACCOUNT_ID / ZOOM_BOT_JID.",
      `Docs: ${formatDocsLink("/channels/zoom", "zoom")}`,
    ].join("\n"),
    "Zoom credentials",
  );
}

/** Prompt user for all Zoom OAuth credentials */
async function promptZoomCredentials(prompter: WizardPrompter): Promise<{
  clientId: string;
  clientSecret: string;
  accountId: string;
  botJid: string;
}> {
  const clientId = String(
    await prompter.text({
      message: "Enter Zoom Client ID",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  const clientSecret = String(
    await prompter.text({
      message: "Enter Zoom Client Secret",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  const accountId = String(
    await prompter.text({
      message: "Enter Zoom Account ID",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  const botJid = String(
    await prompter.text({
      message: "Enter Zoom Bot JID",
      placeholder: "xxx@xmpp.zoom.us",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
  return { clientId, clientSecret, accountId, botJid };
}

function setZoomGroupPolicy(
  cfg: MoltbotConfig,
  groupPolicy: "open" | "allowlist" | "disabled",
): MoltbotConfig {
  const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zoom: {
        ...zoomCfg,
        enabled: true,
        groupPolicy,
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Zoom",
  channel,
  policyKey: "channels.zoom.dmPolicy",
  allowFromKey: "channels.zoom.allowFrom",
  getCurrent: (cfg) => (cfg.channels?.zoom as ZoomConfig | undefined)?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setZoomDmPolicy(cfg, policy),
  promptAllowFrom: promptZoomAllowFrom,
};

export const zoomOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
    const configured = Boolean(resolveZoomCredentials(zoomCfg));
    return {
      channel,
      configured,
      statusLines: [`Zoom: ${configured ? "configured" : "needs app credentials"}`],
      selectionHint: configured ? "configured" : "needs app creds",
      quickstartScore: configured ? 2 : 0,
    };
  },
  configure: async ({ cfg, prompter }) => {
    const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
    const resolved = resolveZoomCredentials(zoomCfg);
    const hasConfigCreds = Boolean(
      zoomCfg?.clientId?.trim() &&
        zoomCfg?.clientSecret?.trim() &&
        zoomCfg?.accountId?.trim() &&
        zoomCfg?.botJid?.trim(),
    );
    const canUseEnv = Boolean(
      !hasConfigCreds &&
        process.env.ZOOM_CLIENT_ID?.trim() &&
        process.env.ZOOM_CLIENT_SECRET?.trim() &&
        process.env.ZOOM_ACCOUNT_ID?.trim() &&
        process.env.ZOOM_BOT_JID?.trim(),
    );

    let next = cfg;
    let clientId: string | null = null;
    let clientSecret: string | null = null;
    let accountId: string | null = null;
    let botJid: string | null = null;
    let webhookSecretToken: string | null = null;

    if (!resolved) {
      await noteZoomCredentialHelp(prompter);
    }

    if (canUseEnv) {
      const keepEnv = await prompter.confirm({
        message:
          "ZOOM_CLIENT_ID + ZOOM_CLIENT_SECRET + ZOOM_ACCOUNT_ID + ZOOM_BOT_JID detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            zoom: { ...(next.channels?.zoom as ZoomConfig), enabled: true },
          },
        };
      } else {
        const creds = await promptZoomCredentials(prompter);
        clientId = creds.clientId;
        clientSecret = creds.clientSecret;
        accountId = creds.accountId;
        botJid = creds.botJid;
      }
    } else if (hasConfigCreds) {
      const keep = await prompter.confirm({
        message: "Zoom credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        const creds = await promptZoomCredentials(prompter);
        clientId = creds.clientId;
        clientSecret = creds.clientSecret;
        accountId = creds.accountId;
        botJid = creds.botJid;
      }
    } else {
      const creds = await promptZoomCredentials(prompter);
      clientId = creds.clientId;
      clientSecret = creds.clientSecret;
      accountId = creds.accountId;
      botJid = creds.botJid;
    }

    // Optionally prompt for webhook secret
    const wantsWebhookSecret = await prompter.confirm({
      message: "Configure webhook secret token for signature verification?",
      initialValue: true,
    });
    if (wantsWebhookSecret) {
      webhookSecretToken = String(
        await prompter.text({
          message: "Enter Zoom Webhook Secret Token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (clientId && clientSecret && accountId && botJid) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          zoom: {
            ...(next.channels?.zoom as ZoomConfig),
            enabled: true,
            clientId,
            clientSecret,
            accountId,
            botJid,
            ...(webhookSecretToken ? { webhookSecretToken } : {}),
          },
        },
      };
    } else if (webhookSecretToken) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          zoom: {
            ...(next.channels?.zoom as ZoomConfig),
            webhookSecretToken,
          },
        },
      };
    }

    // Configure channel access
    const nextZoomCfg = next.channels?.zoom as ZoomConfig | undefined;
    const currentEntries = Object.keys(nextZoomCfg?.channels ?? {});
    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "Zoom channels",
      currentPolicy: nextZoomCfg?.groupPolicy ?? "allowlist",
      currentEntries,
      placeholder: "channel-jid, channel-name",
      updatePrompt: Boolean(nextZoomCfg?.channels),
    });
    if (accessConfig) {
      if (accessConfig.policy !== "allowlist") {
        next = setZoomGroupPolicy(next, accessConfig.policy);
      } else {
        const channels: Record<string, unknown> = {};
        for (const entry of accessConfig.entries) {
          channels[entry] = {};
        }
        next = setZoomGroupPolicy(next, "allowlist");
        next = {
          ...next,
          channels: {
            ...next.channels,
            zoom: {
              ...(next.channels?.zoom as ZoomConfig),
              channels,
            },
          },
        };
      }
    }

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },
  dmPolicy,
  disable: (cfg) => {
    const zoomCfg = cfg.channels?.zoom as ZoomConfig | undefined;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zoom: { ...zoomCfg, enabled: false },
      },
    };
  },
};
