import type { MoltbotConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import { resolveZoomAccount, type ZoomConfig } from "../../../zoom/config.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { addWildcardAllowFrom } from "./helpers.js";

const channel = "zoom" as const;

function setZoomDmPolicy(cfg: MoltbotConfig, dmPolicy: DmPolicy) {
  const zoomConfig = (cfg.channels as any)?.zoom as ZoomConfig | undefined;
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(zoomConfig?.dm?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      zoom: {
        ...zoomConfig,
        dm: {
          ...zoomConfig?.dm,
          policy: dmPolicy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    },
  };
}

async function noteZoomHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Go to Zoom App Marketplace (marketplace.zoom.us/develop/create)",
      "2) Create a Team Chat App and enable Bot feature",
      "3) Copy Client ID, Client Secret, Bot JID, and Secret Token",
      "4) Configure webhook URL to point to your gateway",
      `Docs: ${formatDocsLink("/channels/zoom")}`,
      "Website: https://molt.bot",
    ].join("\n"),
    "Zoom Team Chat setup",
  );
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Zoom",
  channel,
  policyKey: "channels.zoom.dm.policy",
  allowFromKey: "channels.zoom.dm.allowFrom",
  getCurrent: (cfg) => {
    const zoomConfig = (cfg.channels as any)?.zoom as ZoomConfig | undefined;
    return zoomConfig?.dm?.policy ?? "pairing";
  },
  setPolicy: (cfg, policy) => setZoomDmPolicy(cfg, policy),
};

export const zoomOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const account = resolveZoomAccount({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
    });
    const configured = Boolean(
      account.clientId?.trim() &&
      account.clientSecret?.trim() &&
      account.botJid?.trim() &&
      account.secretToken?.trim(),
    );
    return {
      channel,
      configured,
      statusLines: [`Zoom: ${configured ? "configured" : "not configured"}`],
      selectionHint: configured ? "configured" : "not configured",
      quickstartScore: configured ? 2 : 3,
    };
  },
  configure: async ({ cfg, prompter }) => {
    const zoomConfig = (cfg.channels as any)?.zoom as ZoomConfig | undefined;
    let next = cfg;

    await noteZoomHelp(prompter);

    const clientId = String(
      await prompter.text({
        message: "Zoom Client ID",
        placeholder: "lfcOyplW...",
        validate: (value) => {
          const trimmed = String(value ?? "").trim();
          return trimmed ? undefined : "Client ID is required";
        },
      }),
    ).trim();

    const clientSecret = String(
      await prompter.text({
        message: "Zoom Client Secret",
        placeholder: "rm48DW7m...",
        validate: (value) => {
          const trimmed = String(value ?? "").trim();
          return trimmed ? undefined : "Client Secret is required";
        },
      }),
    ).trim();

    const botJid = String(
      await prompter.text({
        message: "Zoom Bot JID",
        placeholder: "bot@xmpp.zoom.us",
        validate: (value) => {
          const str = String(value ?? "").trim();
          return str.includes("@xmpp")
            ? undefined
            : "Bot JID should contain @xmpp.zoom.us or @xmppdev.zoom.us";
        },
      }),
    ).trim();

    const secretToken = String(
      await prompter.text({
        message: "Zoom Secret Token",
        placeholder: "kVJhHKxo...",
        validate: (value) => {
          const trimmed = String(value ?? "").trim();
          return trimmed ? undefined : "Secret Token is required";
        },
      }),
    ).trim();

    // Determine environment from Bot JID
    const isDev = botJid.includes("@xmppdev");
    const apiHost = isDev ? "https://zoomdev.us" : "https://api.zoom.us";
    const oauthHost = isDev ? "https://zoomdev.us" : "https://zoom.us";

    next = {
      ...next,
      channels: {
        ...next.channels,
        zoom: {
          ...zoomConfig,
          enabled: true,
          clientId,
          clientSecret,
          botJid,
          secretToken,
          apiHost,
          oauthHost,
        },
      },
    };

    return { cfg: next };
  },
  dmPolicy,
  disable: (cfg) => {
    const zoomConfig = (cfg.channels as any)?.zoom as ZoomConfig | undefined;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        zoom: { ...zoomConfig, enabled: false },
      },
    };
  },
};
