/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderChannelPairingDetail,
  renderChannelPairingPrompt,
  renderChannelPairingQueue,
} from "./view.pairing.ts";
import type { ChannelsProps } from "./view.types.ts";

const request = {
  requestId: "opaque-request-id",
  channel: "whatsapp",
  channelLabel: "WhatsApp",
  accountId: "personal",
  accountLabel: "Personal",
  senderId: "+15551234567",
  senderLabel: "Phone number",
  metadata: { name: "Alice" },
  createdAt: "2026-07-20T10:00:00.000Z",
  lastSeenAt: "2026-07-20T10:05:00.000Z",
  expiresAt: "2026-07-20T11:00:00.000Z",
  notifySupported: true,
} as const;

function createProps(overrides: Partial<ChannelsProps> = {}): ChannelsProps {
  return {
    connected: true,
    loading: false,
    snapshot: null,
    lastError: null,
    lastSuccessAt: null,
    pairingLoading: false,
    pairingSnapshot: {
      accounts: [
        {
          channel: "whatsapp",
          channelLabel: "WhatsApp",
          accountId: "personal",
          accountLabel: "Personal",
          notifySupported: true,
        },
      ],
      requests: [request],
      commandOwnerConfigured: false,
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
    onShowDetail: () => undefined,
    onCloseDetail: () => undefined,
    onStartSetup: () => undefined,
    onWizardAnswer: () => undefined,
    onWizardToggleMultiselect: () => undefined,
    onWizardTextInput: () => undefined,
    onWizardToggleSecretVisibility: () => undefined,
    onWizardClose: () => undefined,
    onRefresh: () => undefined,
    onPairingRefresh: () => undefined,
    onPairingFilterChange: () => undefined,
    onPairingReviewAccount: () => undefined,
    onPairingApprove: () => undefined,
    onPairingDismiss: () => undefined,
    onPairingPromptChange: () => undefined,
    onPairingPromptCancel: () => undefined,
    onPairingPromptConfirm: () => undefined,
    onWhatsAppStart: () => undefined,
    onWhatsAppWait: () => undefined,
    onWhatsAppLogout: () => undefined,
    onShowAdvancedSettings: () => undefined,
    onConfigPatch: () => undefined,
    onConfigSave: () => undefined,
    onConfigReload: () => undefined,
    onNostrProfileEdit: () => undefined,
    onNostrProfileCancel: () => undefined,
    onNostrProfileFieldChange: () => undefined,
    onNostrProfileSave: () => undefined,
    onNostrProfileImport: () => undefined,
    onNostrProfileToggleAdvanced: () => undefined,
    ...overrides,
  };
}

// Rendered prompts mount <openclaw-modal-dialog> into document.body; leaked
// containers keep an open dialog alive and poison later dialog-owning test
// files in the same worker.
const renderedContainers: HTMLDivElement[] = [];

afterEach(() => {
  for (const container of renderedContainers.splice(0)) {
    container.remove();
  }
});

function renderInto(template: unknown): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  renderedContainers.push(container);
  render(template as never, container);
  return container;
}

// These render into the shared document, so a missing teardown leaks pairing
// dialogs into whichever suite the worker runs next.
afterEach(() => {
  document.body.replaceChildren();
});

describe("channel DM access request views", () => {
  it("renders pending senders without exposing the pairing code", () => {
    const onApprove = vi.fn();
    const onDismiss = vi.fn();
    const container = renderInto(
      renderChannelPairingQueue(
        createProps({ onPairingApprove: onApprove, onPairingDismiss: onDismiss }),
      ),
    );

    expect(container.textContent).toContain("+15551234567");
    expect(container.textContent).toContain("Alice");
    expect(container.textContent).not.toContain("SECRET12");
    const buttons = Array.from(container.querySelectorAll("button"));
    buttons.find((button) => button.textContent?.trim() === "Approve")?.click();
    buttons.find((button) => button.textContent?.trim() === "Dismiss")?.click();
    expect(onApprove).toHaveBeenCalledWith(request);
    expect(onDismiss).toHaveBeenCalledWith(request);
  });

  it("hides cached sender data without pairing access", () => {
    const container = renderInto(
      renderChannelPairingQueue(createProps({ canManagePairing: false })),
    );

    expect(container.textContent).toContain("operator.pairing access");
    expect(container.querySelector(".settings-status--warn")?.textContent).toContain(
      "operator.pairing access",
    );
    expect(container.querySelector(".callout")).toBeNull();
    expect(container.textContent).not.toContain("+15551234567");
    expect(container.textContent).not.toContain("Alice");
  });

  it("renders notice and error feedback as status rows without nested callouts", () => {
    const noticeContainer = renderInto(
      renderChannelPairingQueue(createProps({ pairingNotice: "Request approved" })),
    );
    const notice = noticeContainer.querySelector('[role="status"]');

    expect(notice?.textContent).toContain("Request approved");
    expect(noticeContainer.querySelector(".callout")).toBeNull();

    const errorContainer = renderInto(
      renderChannelPairingQueue(createProps({ pairingError: "Approval failed" })),
    );
    const error = errorContainer.querySelector('[role="alert"]');

    expect(error?.textContent).toContain("Approval failed");
    expect(errorContainer.querySelector(".callout")).toBeNull();
  });

  it("uses the channel picker and clears the account filter when the channel changes", () => {
    const onPairingFilterChange = vi.fn();
    const base = createProps();
    const container = renderInto(
      renderChannelPairingQueue(
        createProps({
          pairingChannelFilter: "whatsapp",
          pairingAccountFilter: "personal",
          pairingSnapshot: {
            ...base.pairingSnapshot!,
            accounts: [
              ...base.pairingSnapshot!.accounts,
              {
                channel: "telegram",
                channelLabel: "Telegram",
                accountId: "work",
                accountLabel: "Work",
                notifySupported: true,
              },
            ],
          },
          onPairingFilterChange,
        }),
      ),
    );

    const selects = container.querySelectorAll<HTMLElement & { value: string }>("wa-select");
    const channel = selects.item(0);
    const account = selects.item(1);
    expect(channel?.querySelector('wa-option[value="whatsapp"] img')).not.toBeNull();
    expect(selects).toHaveLength(2);
    expect(container.querySelectorAll("select.settings-select")).toHaveLength(0);
    expect(account.querySelector("wa-option[selected]")?.getAttribute("value")).toBe("personal");
    Object.defineProperty(channel, "value", { configurable: true, value: "telegram" });
    channel.dispatchEvent(new Event("change", { bubbles: true }));
    Reflect.deleteProperty(channel, "value");
    expect(onPairingFilterChange).toHaveBeenCalledWith("telegram", null);
  });

  it("disables every request action while one mutation is active", () => {
    const secondRequest = {
      ...request,
      requestId: "other-request",
      senderId: "987654321",
    };
    const props = createProps({
      pairingBusyRequestId: request.requestId,
      pairingSnapshot: {
        ...createProps().pairingSnapshot!,
        requests: [request, secondRequest],
      },
    });
    const container = renderInto(renderChannelPairingQueue(props));
    const actionButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((button) => /^(Approve|Dismiss) /u.test(button.getAttribute("aria-label") ?? ""));

    expect(actionButtons).toHaveLength(4);
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
  });

  it("shows explicit notification and first-owner choices for an admin", () => {
    const container = renderInto(
      renderChannelPairingPrompt(
        createProps({
          pairingPrompt: {
            kind: "approve",
            request,
            notify: false,
            bootstrapCommandOwner: false,
          },
        }),
      ),
    );

    expect(container.textContent).toContain("Notify the requester after approval");
    expect(container.textContent).toContain("Also make this sender the first command owner");
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it("links a channel account detail back to the filtered request queue", () => {
    const review = vi.fn();
    const container = renderInto(
      renderChannelPairingDetail("whatsapp", createProps({ onPairingReviewAccount: review })),
    );

    expect(container.textContent).toContain("1 pending");
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === "Review requests",
    );
    button?.click();
    expect(review).toHaveBeenCalledWith("whatsapp", "personal");
  });
});
