// Channels page view tests.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppStatus } from "../../api/types.ts";
import { renderChannelDetail } from "./view.detail.ts";
import {
  channelEnabled,
  resolveChannelConfigured,
  resolveChannelDisplayState,
} from "./view.shared.ts";
import { renderChannels } from "./view.ts";
import type { ChannelsChannelData, ChannelsProps } from "./view.types.ts";
import { renderWhatsAppCard } from "./view.whatsapp.ts";

function createProps(snapshot: ChannelsProps["snapshot"]): ChannelsProps {
  return {
    connected: true,
    loading: false,
    snapshot,
    lastError: null,
    lastSuccessAt: null,
    pairingLoading: false,
    pairingSnapshot: {
      accounts: [],
      requests: [],
      commandOwnerConfigured: true,
      limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
    },
    pairingError: null,
    pairingLastSuccessAt: null,
    pairingBusyRequestId: null,
    pairingChannelFilter: null,
    pairingAccountFilter: null,
    pairingPrompt: null,
    pairingNotice: null,
    canManagePairing: true,
    canAdmin: true,
    whatsappMessage: null,
    whatsappQrDataUrl: null,
    whatsappConnected: null,
    whatsappBusy: false,
    configSchema: null,
    configSchemaLoading: false,
    configForm: null,
    configUiHints: {},
    configSaving: false,
    configFormDirty: false,
    showAdvancedSettings: false,
    nostrProfileFormState: null,
    nostrProfileAccountId: null,
    selectedChannel: null,
    wizard: { phase: "idle" },
    wizardMultiselect: [],
    wizardTextValue: "",
    wizardSecretVisible: false,
    setupBlockedByDirtyConfig: false,
    onShowDetail: () => {},
    onCloseDetail: () => {},
    onStartSetup: () => {},
    onWizardAnswer: () => {},
    onWizardToggleMultiselect: () => {},
    onWizardTextInput: () => {},
    onWizardToggleSecretVisibility: () => {},
    onWizardClose: () => {},
    onRefresh: () => {},
    onPairingRefresh: () => {},
    onPairingFilterChange: () => {},
    onPairingReviewAccount: () => {},
    onPairingApprove: () => {},
    onPairingDismiss: () => {},
    onPairingPromptChange: () => {},
    onPairingPromptCancel: () => {},
    onPairingPromptConfirm: () => {},
    onWhatsAppStart: () => {},
    onWhatsAppWait: () => {},
    onWhatsAppLogout: () => {},
    onShowAdvancedSettings: () => {},
    onConfigPatch: () => {},
    onConfigSave: () => {},
    onConfigReload: () => {},
    onNostrProfileEdit: () => {},
    onNostrProfileCancel: () => {},
    onNostrProfileFieldChange: () => {},
    onNostrProfileSave: () => {},
    onNostrProfileImport: () => {},
    onNostrProfileToggleAdvanced: () => {},
  };
}

describe("channels setup access", () => {
  it("replaces setup actions with an admin-required notice for non-admin viewers", () => {
    const onStartSetup = vi.fn();
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
      channels: { telegram: { configured: false } },
      channelAccounts: {},
      channelDefaultAccountId: {},
    });
    props.canAdmin = false;
    props.onStartSetup = onStartSetup;
    const container = document.createElement("div");
    render(renderChannels(props), container);

    expect(container.textContent).toContain(
      "Browsing only. Channel setup requires operator.admin access.",
    );
    expect(
      [...container.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).not.toContain("Set up");
    expect(container.textContent).not.toContain("More channels…");
    expect(onStartSetup).not.toHaveBeenCalled();
  });
});

function createWhatsAppStatus(overrides: Partial<WhatsAppStatus> = {}): WhatsAppStatus {
  return {
    configured: true,
    linked: false,
    running: false,
    connected: false,
    reconnectAttempts: 0,
    ...overrides,
  };
}

function renderWhatsAppButtons(params: {
  linked?: boolean;
  qrDataUrl?: string | null;
  onWhatsAppStart?: ChannelsProps["onWhatsAppStart"];
}) {
  const whatsapp = createWhatsAppStatus({ linked: params.linked === true });
  const props = createProps({
    ts: Date.now(),
    channelOrder: ["whatsapp"],
    channelLabels: { whatsapp: "WhatsApp" },
    channels: { whatsapp },
    channelAccounts: {},
    channelDefaultAccountId: {},
  });
  props.whatsappQrDataUrl = params.qrDataUrl ?? null;
  if (params.onWhatsAppStart) {
    props.onWhatsAppStart = params.onWhatsAppStart;
  }

  const container = document.createElement("div");
  render(renderWhatsAppCard({ props, whatsapp }), container);
  const buttons = Array.from(container.querySelectorAll("button"));
  return {
    container,
    buttons,
    labels: buttons.map((button) => button.textContent?.trim()),
  };
}

function renderChannelDetailFixture(
  channelId: string,
  data: ChannelsChannelData,
  options: { label?: string; onRefresh?: ChannelsProps["onRefresh"] } = {},
) {
  const status = Object.entries(data).find(([key]) => key === channelId)?.[1] ?? {};
  const channelAccounts = data.channelAccounts ?? {};
  const accounts = Object.hasOwn(channelAccounts, channelId) ? channelAccounts[channelId] : [];
  const props = createProps({
    ts: Date.now(),
    channelOrder: [channelId],
    channelLabels: { [channelId]: options.label ?? channelId },
    channels: { [channelId]: status },
    channelAccounts,
    channelDefaultAccountId: accounts?.length ? { [channelId]: accounts[0]!.accountId } : {},
  });
  if (options.onRefresh) {
    props.onRefresh = options.onRefresh;
  }
  const container = document.createElement("div");
  render(
    renderChannelDetail({
      channelId,
      label: options.label ?? channelId,
      props,
      data: { ...data, channelAccounts },
      onClose: () => {},
      onSetup: () => {},
    }),
    container,
  );
  return container;
}

// Mirrors the tiers the gateway materializes on every channel schema path.
const CHANNEL_TIER_SCHEMA = {
  type: "object",
  properties: {
    channels: {
      type: "object",
      properties: {
        whatsapp: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            timeoutMs: { type: "integer" },
            retry: {
              type: "object",
              properties: { attempts: { type: "integer" } },
            },
          },
        },
      },
    },
  },
};

const CHANNEL_TIER_HINTS = {
  "channels.whatsapp.enabled": { advanced: false },
  "channels.whatsapp.timeoutMs": { advanced: true },
  "channels.whatsapp.retry": { advanced: true },
  "channels.whatsapp.retry.attempts": { advanced: true },
};

function renderWhatsAppConfigForm(
  showAdvancedSettings: boolean,
  hints: Record<string, { advanced: boolean }> = CHANNEL_TIER_HINTS,
) {
  const whatsapp = createWhatsAppStatus();
  const props = createProps({
    ts: Date.now(),
    channelOrder: ["whatsapp"],
    channelLabels: { whatsapp: "WhatsApp" },
    channels: { whatsapp },
    channelAccounts: {},
    channelDefaultAccountId: {},
  });
  const onShowAdvancedSettings = vi.fn();
  props.configSchema = CHANNEL_TIER_SCHEMA;
  props.configUiHints = hints;
  props.configForm = { channels: { whatsapp: { enabled: true, timeoutMs: 5000 } } };
  props.showAdvancedSettings = showAdvancedSettings;
  props.onShowAdvancedSettings = onShowAdvancedSettings;

  const container = document.createElement("div");
  render(renderWhatsAppCard({ props, whatsapp }), container);
  return { container, onShowAdvancedSettings };
}

describe("channel config advanced tier", () => {
  it("hides advanced channel settings behind the ghost row by default", () => {
    const { container, onShowAdvancedSettings } = renderWhatsAppConfigForm(false);

    expect(container.textContent).toContain("Enabled");
    expect(container.textContent).not.toContain("Timeout Ms");
    expect(container.querySelector(".config-advanced-divider")).toBeNull();

    const ghost = container.querySelector<HTMLButtonElement>(".config-advanced-ghost");
    expect(ghost?.textContent).toContain("2 advanced settings hidden");
    ghost!.click();
    expect(onShowAdvancedSettings).toHaveBeenCalledWith(true);
  });

  it("reveals advanced channel settings with a collapse affordance", () => {
    const { container, onShowAdvancedSettings } = renderWhatsAppConfigForm(true);

    expect(container.textContent).toContain("Enabled");
    expect(container.textContent).toContain("Timeout Ms");
    expect(container.querySelector(".config-advanced-ghost")).toBeNull();

    const collapse = container.querySelector<HTMLButtonElement>(".config-advanced-divider__toggle");
    expect(collapse).toBeInstanceOf(HTMLButtonElement);
    collapse!.click();
    expect(onShowAdvancedSettings).toHaveBeenCalledWith(false);
  });

  it("keeps the collapse control for channels whose settings are all advanced", () => {
    const { container, onShowAdvancedSettings } = renderWhatsAppConfigForm(true, {
      ...CHANNEL_TIER_HINTS,
      "channels.whatsapp.enabled": { advanced: true },
    });

    const collapse = container.querySelector<HTMLButtonElement>(".config-advanced-divider__toggle");
    expect(collapse).toBeInstanceOf(HTMLButtonElement);
    collapse!.click();
    expect(onShowAdvancedSettings).toHaveBeenCalledWith(false);
  });

  it("renders field help from the resolved hints", () => {
    const { container } = renderWhatsAppConfigForm(false, {
      ...CHANNEL_TIER_HINTS,
      "channels.whatsapp.enabled": { advanced: false, help: "Turn this channel on or off." },
    } as typeof CHANNEL_TIER_HINTS);

    const help = Array.from(container.querySelectorAll(".settings-row__desc")).map((node) =>
      node.textContent?.trim(),
    );
    expect(help).toContain("Turn this channel on or off.");
  });
});

describe("channel detail", () => {
  it("links every channel to its docs page", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
      channels: { telegram: { configured: true } },
      channelAccounts: {},
      channelDefaultAccountId: {},
    });

    const container = document.createElement("div");
    render(
      renderChannelDetail({
        channelId: "telegram",
        label: "Telegram",
        props,
        data: {},
        onClose: () => {},
        onSetup: () => {},
      }),
      container,
    );

    const docs = container.querySelector<HTMLAnchorElement>(".channels-detail__header-actions a");
    expect(docs?.href).toBe("https://docs.openclaw.ai/channels/telegram");
    expect(docs?.textContent?.trim()).toBe("Docs");
  });

  it.each([
    ["discord", "Discord", []],
    ["slack", "Slack", []],
    ["signal", "Signal", [["Base URL", "https://signal.example"]]],
    ["imessage", "iMessage", []],
    [
      "googlechat",
      "Google Chat",
      [
        ["Credential", "service-account"],
        ["Audience", "url · https://chat.example"],
      ],
    ],
    ["telegram", "Telegram", [["Mode", "polling"]]],
  ] satisfies Array<[string, string, Array<[string, string]>]>)(
    "preserves localized status facts and probe actions for %s",
    (channelId, title, extraFacts) => {
      const onRefresh = vi.fn();
      const status = {
        configured: true,
        running: true,
        baseUrl: "https://signal.example",
        credentialSource: "service-account",
        audienceType: "url",
        audience: "https://chat.example",
        mode: "polling",
      };
      const data: ChannelsChannelData = { channelAccounts: {}, [channelId]: status };
      const container = renderChannelDetailFixture(channelId, data, { onRefresh });
      const facts = Array.from(container.querySelectorAll("dt"), (node) => [
        node.textContent?.trim(),
        node.nextElementSibling?.textContent?.trim(),
      ]);

      expect(container.querySelector(".settings-section__heading")?.textContent?.trim()).toBe(
        title,
      );
      expect(facts).toEqual([
        ["Configured", "Yes"],
        ["Running", "Yes"],
        ...extraFacts,
        ["Last start", "n/a"],
        ["Last probe", "n/a"],
      ]);
      container.querySelector<HTMLButtonElement>(".settings-row--actions button")!.click();
      expect(onRefresh).toHaveBeenCalledWith(true);
    },
  );

  it("keeps missing Google Chat status unknown while other known channels are stopped", () => {
    const google = renderChannelDetailFixture("googlechat", { googlechat: null });
    const discord = renderChannelDetailFixture("discord", { discord: null });
    const fact = (container: HTMLElement, label: string) =>
      Array.from(container.querySelectorAll("dt"))
        .find((node) => node.textContent?.trim() === label)
        ?.nextElementSibling?.textContent?.trim();

    expect(fact(google, "Running")).toBe("n/a");
    expect(fact(discord, "Running")).toBe("No");
  });

  it.each(["guildchat", "constructor", "__proto__"])(
    "opens accountless plugin %s from its actual hub row without inherited account values",
    (channelId) => {
      for (const configured of [false, true]) {
        const props = createProps({
          ts: Date.now(),
          channelOrder: [channelId],
          channelLabels: { [channelId]: "Custom channel" },
          channels: { [channelId]: { configured, running: configured } },
          channelAccounts: {},
          channelDefaultAccountId: {},
        });
        const container = document.createElement("div");
        props.onShowDetail = (selected) => {
          props.selectedChannel = selected;
          render(renderChannels(props), container);
        };
        render(renderChannels(props), container);
        const trigger = container.querySelector<HTMLButtonElement>(
          configured ? "button.channels-item" : ".channels-item__detail",
        );

        expect(trigger).toBeInstanceOf(HTMLButtonElement);
        trigger!.click();
        const detail = container.querySelector(".channels-detail");
        expect(detail?.querySelector(".settings-section__heading")?.textContent?.trim()).toBe(
          "Custom channel",
        );
        expect(detail?.textContent).toContain("Channel status and configuration.");
        expect(
          Array.from(detail!.querySelectorAll("dt"), (node) => node.textContent?.trim()),
        ).toEqual(["Configured", "Running", "Connected"]);
      }
    },
  );
});

describe("channel display selectors", () => {
  it("returns the channel summary configured flag when present", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["guildchat"],
      channelLabels: { guildchat: "Guild Chat" },
      channels: { guildchat: { configured: false } },
      channelAccounts: {
        guildchat: [{ accountId: "guild-main", configured: true }],
      },
      channelDefaultAccountId: { guildchat: "guild-main" },
    });

    expect(resolveChannelConfigured("guildchat", props)).toBe(false);
    expect(resolveChannelDisplayState("guildchat", props).configured).toBe(false);
  });

  it("falls back to the default account when the channel summary omits configured", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["guildchat"],
      channelLabels: { guildchat: "Guild Chat" },
      channels: { guildchat: { running: true } },
      channelAccounts: {
        guildchat: [
          { accountId: "default", configured: false },
          { accountId: "guild-main", configured: true },
        ],
      },
      channelDefaultAccountId: { guildchat: "guild-main" },
    });

    const displayState = resolveChannelDisplayState("guildchat", props);

    expect(resolveChannelConfigured("guildchat", props)).toBe(true);
    expect(displayState.defaultAccount?.accountId).toBe("guild-main");
    expect(channelEnabled("guildchat", props)).toBe(true);
  });

  it("falls back to the first account when no default account id is available", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["workspace"],
      channelLabels: { workspace: "Workspace" },
      channels: { workspace: { running: true } },
      channelAccounts: {
        workspace: [{ accountId: "workspace-a", configured: true }],
      },
      channelDefaultAccountId: {},
    });

    const displayState = resolveChannelDisplayState("workspace", props);

    expect(resolveChannelConfigured("workspace", props)).toBe(true);
    expect(displayState.defaultAccount?.accountId).toBe("workspace-a");
  });

  it("keeps disabled channels hidden when neither summary nor accounts are active", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["quietchat"],
      channelLabels: { quietchat: "Quiet Chat" },
      channels: { quietchat: {} },
      channelAccounts: {
        quietchat: [{ accountId: "default", configured: false, running: false, connected: false }],
      },
      channelDefaultAccountId: { quietchat: "default" },
    });

    const displayState = resolveChannelDisplayState("quietchat", props);

    expect(displayState.configured).toBe(false);
    expect(displayState.running).toBeNull();
    expect(displayState.connected).toBeNull();
    expect(channelEnabled("quietchat", props)).toBe(false);
  });
});

describe("WhatsApp status", () => {
  function renderPhoneFact(self: WhatsAppStatus["self"]): string | undefined {
    const whatsapp = createWhatsAppStatus({ linked: true, self });
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["whatsapp"],
      channelLabels: { whatsapp: "WhatsApp" },
      channels: { whatsapp },
      channelAccounts: {},
      channelDefaultAccountId: {},
    });
    const container = document.createElement("div");
    render(renderWhatsAppCard({ props, whatsapp }), container);
    const label = Array.from(container.querySelectorAll("dt")).find(
      (node) => node.textContent?.trim() === "Phone number",
    );
    return label?.nextElementSibling?.textContent?.trim();
  }

  it("renders readable phone identity with raw fallback and no JID fallback", () => {
    expect(renderPhoneFact({ e164: "+4930123456", jid: "4930123456@s.whatsapp.net" })).toBe(
      "Germany · +49 30 123456",
    );
    expect(renderPhoneFact({ e164: "not-a-phone", jid: "account@s.whatsapp.net" })).toBe(
      "not-a-phone",
    );
    expect(renderPhoneFact({ jid: "account@s.whatsapp.net" })).toBeUndefined();
  });
});

describe("WhatsApp card actions", () => {
  it("shows QR as the primary action before WhatsApp is linked", () => {
    const onWhatsAppStart = vi.fn();
    const { buttons, labels } = renderWhatsAppButtons({
      linked: false,
      onWhatsAppStart,
    });

    expect(labels).toEqual(["Save", "Reload", "Show QR", "Logout", "Refresh"]);

    const showQr = buttons.find((button) => button.textContent?.trim() === "Show QR");
    expect(showQr).toBeInstanceOf(HTMLButtonElement);
    showQr!.click();
    expect(onWhatsAppStart).toHaveBeenCalledWith(false);
  });

  it("uses relink as the explicit action after WhatsApp is linked", () => {
    const onWhatsAppStart = vi.fn();
    const { buttons, labels } = renderWhatsAppButtons({
      linked: true,
      onWhatsAppStart,
    });

    expect(labels).toEqual(["Save", "Reload", "Relink", "Logout", "Refresh"]);

    const relink = buttons.find((button) => button.textContent?.trim() === "Relink");
    expect(relink).toBeInstanceOf(HTMLButtonElement);
    relink!.click();
    expect(onWhatsAppStart).toHaveBeenCalledWith(true);
  });

  it("shows wait for scan only while a QR is displayed", () => {
    const { labels } = renderWhatsAppButtons({
      linked: false,
      qrDataUrl: "data:image/png;base64,current-qr",
    });

    expect(labels).toEqual(["Save", "Reload", "Show QR", "Wait for scan", "Logout", "Refresh"]);
  });

  it("renders the QR directly above the action row so it is visible next to Show QR", () => {
    const { container } = renderWhatsAppButtons({
      linked: false,
      qrDataUrl: "data:image/png;base64,current-qr",
    });

    const qrRow = container.querySelector(".qr-wrap")?.closest(".settings-row");
    expect(qrRow).not.toBeNull();
    expect(qrRow?.nextElementSibling?.classList.contains("settings-row--actions")).toBe(true);
  });
});
