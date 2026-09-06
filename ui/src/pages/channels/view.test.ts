// Channels page view tests.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppStatus } from "../../api/types.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import { renderChannelDetail } from "./view.detail.ts";
import {
  channelEnabled,
  resolveChannelConfigured,
  resolveChannelDisplayState,
} from "./view.shared.ts";
import { createChannelsViewProps } from "./view.test-support.ts";
import { renderChannels } from "./view.ts";
import type { ChannelsChannelData, ChannelsProps } from "./view.types.ts";
import { renderWhatsAppCard } from "./view.whatsapp.ts";

function createProps(snapshot: ChannelsProps["snapshot"]): ChannelsProps {
  return createChannelsViewProps(snapshot, {
    accounts: [],
    requests: [],
    commandOwnerConfigured: true,
    limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
  });
}

describe("channel hub refresh actions", () => {
  it("keeps both timestamps in icon-button tooltips", () => {
    const onRefresh = vi.fn();
    const onPairingRefresh = vi.fn();
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["slack"],
      channelLabels: { slack: "Slack" },
      channels: { slack: { configured: true } },
      channelAccounts: {},
      channelDefaultAccountId: {},
    });
    props.lastSuccessAt = Date.now();
    props.pairingLastSuccessAt = Date.now();
    props.onRefresh = onRefresh;
    props.onPairingRefresh = onPairingRefresh;
    const container = document.createElement("div");

    render(renderChannels(props), container);

    const refreshButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="Refresh"]'),
    );
    expect(refreshButtons).toHaveLength(2);
    expect(refreshButtons.map((button) => button.textContent?.trim())).toEqual(["", ""]);
    expect(container.textContent).not.toContain("Updated just now");
    expect(
      refreshButtons.map(
        (button) =>
          (button.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
            ?.content,
      ),
    ).toEqual(["Updated just now", "Updated just now"]);

    refreshButtons[0]!.click();
    refreshButtons[1]!.click();
    expect(onPairingRefresh).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledWith(true);
  });
});

function createChannelPlugin(overrides: Partial<PluginCatalogItem> = {}): PluginCatalogItem {
  return {
    id: "slack",
    name: "Slack",
    description: "OpenClaw Slack channel plugin for channels, DMs, commands, and app events.",
    origin: "bundled",
    installed: true,
    enabled: false,
    state: "disabled",
    hasIcon: true,
    ...overrides,
  };
}

describe("channels plugin presentation metadata", () => {
  it("uses matching plugins.list metadata for the gallery and setup modal", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["slack"],
      channelLabels: { slack: "slack" },
      channelDetailLabels: { slack: "Legacy channel subtitle" },
      channels: { slack: { configured: false } },
      channelAccounts: {},
      channelDefaultAccountId: {},
    });
    props.pluginCatalog = {
      plugins: [createChannelPlugin()],
      diagnostics: [],
      mutationAllowed: true,
    };
    props.pluginIconUrls = { slack: "blob:slack-plugin-icon" };
    props.selectedChannel = "slack";
    props.wizard = { phase: "error", channel: "slack", message: "Setup failed" };
    const container = document.createElement("div");

    render(renderChannels(props), container);

    const row = container.querySelector(".channels-item");
    expect(row?.querySelector(".settings-row__title")?.textContent).toBe("Slack");
    expect(row?.querySelector(".settings-row__desc")?.textContent).toBe(
      "OpenClaw Slack channel plugin for channels, DMs, commands, and app events.",
    );
    expect(row?.querySelector("img")?.getAttribute("src")).toBe("blob:slack-plugin-icon");
    const detailIcon = container.querySelector(
      ".channels-detail__header .channels-cover--icon img",
    );
    expect(detailIcon?.getAttribute("src")).toBe("blob:slack-plugin-icon");
    expect(container.querySelector(".channels-wizard h2")?.textContent).toBe("Set up Slack");
    expect(container.querySelector(".channels-wizard img")?.getAttribute("src")).toBe(
      "blob:slack-plugin-icon",
    );
    expect(container.textContent).not.toContain("Legacy channel subtitle");
  });
});

describe("channels setup access", () => {
  it("keeps unconfigured recommended channels available after one channel is configured", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["slack"],
      channelLabels: { slack: "Slack" },
      channelMeta: [{ id: "slack", label: "Slack", detailLabel: "Slack Bot" }],
      channels: { slack: { configured: true } },
      channelAccounts: {},
      channelDefaultAccountId: {},
    });
    const container = document.createElement("div");

    render(renderChannels(props), container);

    const availableLabels = Array.from(
      container.querySelectorAll(".channels-item__detail .settings-row__title"),
      (node) => node.textContent?.trim(),
    );
    expect(availableLabels).toEqual([
      "whatsapp",
      "telegram",
      "discord",
      "googlechat",
      "signal",
      "imessage",
      "nostr",
    ]);
  });

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

describe("channels section order", () => {
  it("places DM access requests after the channel management sections", () => {
    const props = createProps({
      ts: Date.now(),
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
      channels: { telegram: { configured: false } },
      channelAccounts: {},
      channelDefaultAccountId: {},
    });
    const container = document.createElement("div");
    render(renderChannels(props), container);

    const headings = Array.from(container.querySelectorAll(".settings-section__heading"), (node) =>
      node.textContent?.trim(),
    );
    expect(headings).toEqual(["Connected channels", "Add a channel", "DM access requests"]);
  });
});

describe("channel row actions", () => {
  it.each([
    { list: "connected", action: "details", update: "reorder" },
    { list: "available", action: "details", update: "reorder" },
    { list: "available", action: "setup", update: "reorder" },
    { list: "available", action: "details", update: "connect" },
    { list: "available", action: "setup", update: "connect" },
  ])(
    "keeps $list $action clicks on their channel after a status $update",
    ({ list, action, update }) => {
      const configured = list === "connected";
      const snapshot = {
        ts: 1,
        channelOrder: ["whatsapp", "telegram"],
        channelLabels: { whatsapp: "WhatsApp", telegram: "Telegram" },
        channels: { whatsapp: { configured }, telegram: { configured } },
        channelAccounts: {},
        channelDefaultAccountId: {},
      };
      const props = createProps(snapshot);
      const onAction = vi.fn();
      if (action === "setup") {
        props.onStartSetup = onAction;
      } else {
        props.onShowDetail = onAction;
      }
      const container = document.createElement("div");
      render(renderChannels(props), container);
      const row = Array.from(container.querySelectorAll<HTMLElement>(".channels-item")).find(
        (element) => element.querySelector(".settings-row__title")?.textContent === "Telegram",
      )!;
      const button = row.matches("button")
        ? (row as HTMLButtonElement)
        : row.querySelector<HTMLButtonElement>(
            action === "setup" ? ".btn" : ".channels-item__detail",
          )!;

      props.snapshot = {
        ...snapshot,
        ts: 2,
        ...(update === "connect"
          ? { channels: { ...snapshot.channels, whatsapp: { configured: true } } }
          : { channelOrder: ["telegram", "whatsapp"] }),
      };
      render(renderChannels(props), container);
      expect(container.contains(button)).toBe(true);
      button.click();

      expect(onAction).toHaveBeenCalledExactlyOnceWith("telegram");
    },
  );
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
  options: {
    label?: string;
    loading?: boolean;
    configError?: string;
    onRefresh?: ChannelsProps["onRefresh"];
  } = {},
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
  props.loading = options.loading ?? false;
  props.configError = options.configError ?? null;
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
  it("hides advanced channel settings behind the disclosure by default", () => {
    const { container, onShowAdvancedSettings } = renderWhatsAppConfigForm(false);

    expect(container.textContent).toContain("Enabled");
    expect(container.textContent).not.toContain("Timeout Ms");
    const disclosure = container.querySelector<HTMLDetailsElement>(
      "details.config-advanced-disclosure",
    );
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector("summary")?.textContent?.trim()).toBe("Advanced settings");
    disclosure!.open = true;
    disclosure!.dispatchEvent(new Event("toggle"));
    expect(onShowAdvancedSettings).toHaveBeenCalledWith(true);
  });

  it("reveals advanced channel settings with a collapse affordance", () => {
    const { container, onShowAdvancedSettings } = renderWhatsAppConfigForm(true);

    expect(container.textContent).toContain("Enabled");
    expect(container.textContent).toContain("Timeout Ms");
    const disclosure = container.querySelector<HTMLDetailsElement>(
      "details.config-advanced-disclosure",
    );
    expect(disclosure?.open).toBe(true);
    disclosure!.open = false;
    disclosure!.dispatchEvent(new Event("toggle"));
    expect(onShowAdvancedSettings).toHaveBeenCalledWith(false);
  });

  it("keeps the collapse control for channels whose settings are all advanced", () => {
    const { container, onShowAdvancedSettings } = renderWhatsAppConfigForm(true, {
      ...CHANNEL_TIER_HINTS,
      "channels.whatsapp.enabled": { advanced: true },
    });

    const disclosure = container.querySelector<HTMLDetailsElement>(
      "details.config-advanced-disclosure",
    );
    expect(disclosure?.open).toBe(true);
    disclosure!.open = false;
    disclosure!.dispatchEvent(new Event("toggle"));
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
  it.each(["telegram", "whatsapp", "nostr"] as const)(
    "shows an escaped configuration save error inside the %s editor",
    (channelId) => {
      const data: ChannelsChannelData =
        channelId === "whatsapp"
          ? { whatsapp: createWhatsAppStatus() }
          : channelId === "nostr"
            ? { nostr: null }
            : { telegram: { configured: true, running: true } };
      const message = 'Gateway rejected <img src="x" onerror="alert(1)">';
      const container = renderChannelDetailFixture(channelId, data, { configError: message });
      const alert = container.querySelector(".channels-detail [role=alert]");

      expect(alert?.textContent).toBe(message);
      expect(alert?.querySelector("img")).toBeNull();
    },
  );

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

  it("projects an in-flight channel read onto the detail Probe action", () => {
    const onRefresh = vi.fn();
    const container = renderChannelDetailFixture(
      "telegram",
      { telegram: { configured: true, running: true }, channelAccounts: {} },
      { loading: true, onRefresh },
    );
    const probe = container.querySelector<HTMLButtonElement>(".settings-row--actions button");

    expect(probe?.disabled).toBe(true);
    expect(probe?.getAttribute("aria-busy")).toBe("true");
    expect(probe?.textContent?.trim()).toBe("Refreshing…");
    probe?.click();
    expect(onRefresh).not.toHaveBeenCalled();
  });

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
