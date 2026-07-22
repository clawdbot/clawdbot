// Channels page view tests.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppStatus } from "../../api/types.ts";
import {
  channelEnabled,
  resolveChannelConfigured,
  resolveChannelDisplayState,
} from "./view.shared.ts";
import type { ChannelsProps } from "./view.types.ts";
import { renderWhatsAppCard } from "./view.whatsapp.ts";

function createProps(snapshot: ChannelsProps["snapshot"]): ChannelsProps {
  return {
    connected: true,
    loading: false,
    snapshot,
    lastError: null,
    lastSuccessAt: null,
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
    nostrProfileFormState: null,
    nostrProfileAccountId: null,
    selectedChannel: null,
    wizard: { phase: "idle" },
    wizardMultiselect: [],
    setupBlockedByDirtyConfig: false,
    onShowDetail: () => {},
    onCloseDetail: () => {},
    onStartSetup: () => {},
    onWizardAnswer: () => {},
    onWizardToggleMultiselect: () => {},
    onWizardClose: () => {},
    onRefresh: () => {},
    onWhatsAppStart: () => {},
    onWhatsAppWait: () => {},
    onWhatsAppLogout: () => {},
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
    buttons,
    labels: buttons.map((button) => button.textContent?.trim()),
  };
}

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
});
